// ==UserScript==
// @name         视频字幕一体助手
// @namespace    local.missav.video-subtitle-assistant
// @version      2026.10.12.3
// @description  MissAV 视频最高分辨率下载、断点续传、115网盘番号查找、本地媒体字幕同步、磁力搜索与字幕搜索、预览、加载、倍速助手
// @author       local merge
// @license      MIT
// @run-at       document-start
// @match        *://missav.ws/*
// @match        *://missav.live/*
// @match        *://missav.ai/*
// @match        *://missav123.com/*
// @match        *://missav.fans/*
// @match        *://missav.media/*
// @connect      115.com
// @connect      webapi.115.com
// @connect      proapi.115.com
// @connect      uplb.115.com
// @connect      *.aliyuncs.com
// @connect      sukebei.nyaa.si
// @connect      nyaa.si
// @connect      torrentkitty.tv
// @connect      www.torrentkitty.tv
// @connect      btdig.com
// @connect      www.btdig.com
// @connect      javbus.com
// @connect      www.javbus.com
// @connect      tokyotosho.info
// @connect      www.tokyotosho.info
// @grant        GM_xmlhttpRequest
// @match        *://missav.*/*
// @match        *://missav.com/*
// @match        *://123av.*/*
// @match        *://123av.com/*
// @match        *://supjav.*/*
// @match        *://supjav.com/*
// @match        *://tktube.com/*
// @match        *://jav.guru/*
// @match        *://javtiful.com/*
// @match        *://kissjav.com/*
// @match        *://javmix.tv/*
// @match        *://vjav.com/*
// @match        *://javhd.today/*
// @match        *://javgg.net/*
// @match        *://javfc2.net/*
// @match        *://rou.video/*
// @match        *://www.papalah.com/*
// @match        *://91md.me/*
// @match        *://www.91porn.best/*
// @match        *://www.91porn.com/*
// @match        *://www.91pornn.com/*
// @match        *://cableav.video/*
// @match        *://avhub360.com/*
// @match        *://www.x1hub.com/*
// @match        *://taiav.com/*
// @match        *://mdtt.cc/*
// @match        *://115.com/*
// @match        *://*.115.com/*
// @match        *://www.madou.io/*
// @match        *://91porna.com/*
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @require      https://cdn.jsdelivr.net/npm/mux.js@7.0.0/dist/mux.min.js
// @require      https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js
// @grant        GM_addStyle
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      *
// @connect      xunlei.com
// @connect      api.sub-dog.top
// @connect      *.115.com
// ==/UserScript==

// ===== 视频发现助手 =====
(function () {
    async function fetchVideoList(url) {
        console.log('fetch url :', url)
        const response = await fetch(url)
        if (!response.ok) {
            throw new Error('获取播放列表失败：HTTP ' + response.status)
        }
        const text = await response.text()
        return text
    }
    // 下载分片放进 IndexedDB。刷新页面时只需重新进入当前页面，已完成的分片会继续复用。
    const VIDEO_CACHE_DB = 'missav-video-download-cache-v2'
    const VIDEO_JOB_STORE = 'jobs'
    const VIDEO_SEGMENT_STORE = 'segments'
    const VIDEO_DOWNLOAD_CONCURRENCY = 4
    const VIDEO_RETRY_BASE_DELAY = 1500
    const VIDEO_RETRY_MAX_DELAY = 30000
    const VIDEO_NON_RETRYABLE_MAX_ATTEMPTS = 3
    const VIDEO_HISTORY_PAGE_SIZE = 3
    const activeVideoDownloads = new Map()
    const VIDEO_SYNC_CHANNEL = 'missav-video-download-sync-v1'
    const videoHistoryControls = new Set()
    let videoSyncChannel = null

    function refreshRegisteredVideoHistories() {
        for (const entry of Array.from(videoHistoryControls)) {
            refreshVideoCacheSummary(entry.fileInfo, entry.controls).catch(() => {})
        }
    }

    function ensureVideoSyncChannel() {
        if (videoSyncChannel || typeof BroadcastChannel !== 'function') return videoSyncChannel
        try {
            videoSyncChannel = new BroadcastChannel(VIDEO_SYNC_CHANNEL)
            videoSyncChannel.addEventListener('message', event => {
                const data = event && event.data || {}
                if (data.type === 'video-cache-changed') refreshRegisteredVideoHistories()
            })
        } catch (error) {
            videoSyncChannel = null
            console.warn('[MissAV 下载] 当前浏览器不支持窗口间历史同步：', error)
        }
        return videoSyncChannel
    }

    function registerVideoHistoryControls(fileInfo, controls) {
        const entry = { fileInfo: fileInfo, controls: controls }
        videoHistoryControls.add(entry)
        ensureVideoSyncChannel()
    }

    function notifyVideoCacheChanged(action, jobId) {
        const channel = ensureVideoSyncChannel()
        if (!channel) return
        try {
            channel.postMessage({
                type: 'video-cache-changed',
                action: action,
                jobId: jobId || '',
                at: Date.now()
            })
        } catch (error) {
            console.warn('[MissAV 下载] 窗口间历史同步通知失败：', error)
        }
    }

    function openVideoCacheDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(VIDEO_CACHE_DB, 1)
            request.onupgradeneeded = () => {
                const db = request.result
                if (!db.objectStoreNames.contains(VIDEO_JOB_STORE)) {
                    db.createObjectStore(VIDEO_JOB_STORE, { keyPath: 'id' })
                }
                if (!db.objectStoreNames.contains(VIDEO_SEGMENT_STORE)) {
                    db.createObjectStore(VIDEO_SEGMENT_STORE, { keyPath: ['jobId', 'index'] })
                }
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error || new Error('无法打开下载缓存'))
        })
    }

    function runVideoCacheTransaction(stores, mode, operation) {
        return openVideoCacheDb().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(stores, mode)
            let result
            let settled = false
            const closeAndReject = (error) => {
                if (settled) return
                settled = true
                db.close()
                reject(error || new Error('下载缓存操作失败'))
            }
            tx.onerror = () => closeAndReject(tx.error)
            tx.onabort = () => closeAndReject(tx.error)
            tx.oncomplete = () => {
                if (settled) return
                settled = true
                let value = result
                try {
                    if (result && 'result' in result) value = result.result
                } catch (error) {
                    db.close()
                    reject(error)
                    return
                }
                db.close()
                resolve(value)
            }
            try {
                const handles = Array.isArray(stores)
                    ? stores.map(name => tx.objectStore(name))
                    : tx.objectStore(stores)
                result = Array.isArray(handles)
                    ? operation(...handles)
                    : operation(handles)
            } catch (error) {
                closeAndReject(error)
            }
        }))
    }

    function videoJobId(playlistUrl, filename, segmentSignature) {
        return playlistUrl + '|' + filename + (segmentSignature ? '|segments:' + segmentSignature : '')
    }

    function saveVideoJob(job) {
        return runVideoCacheTransaction(VIDEO_JOB_STORE, 'readwrite', store => store.put(job))
    }

    function getVideoJob(jobId) {
        return runVideoCacheTransaction(VIDEO_JOB_STORE, 'readonly', store => store.get(jobId))
    }

    function saveVideoSegment(jobId, index, blob) {
        return runVideoCacheTransaction(VIDEO_SEGMENT_STORE, 'readwrite', store => {
            return store.put({ jobId: jobId, index: index, blob: blob })
        })
    }

    async function fetchVideoSegment(segment, signal) {
        const hasRange = Number.isFinite(segment && segment.rangeStart) &&
            Number.isFinite(segment && segment.rangeEnd) &&
            segment.rangeEnd >= segment.rangeStart
        const rangeLength = hasRange ? segment.rangeEnd - segment.rangeStart + 1 : 0
        const options = { signal: signal }
        if (hasRange) {
            options.headers = { Range: 'bytes=' + segment.rangeStart + '-' + segment.rangeEnd }
        }
        const response = await fetch(segment.url, options)
        if (!response.ok) {
            const error = new Error('第 ' + ((segment.index || 0) + 1) + ' 个分片下载失败：HTTP ' + response.status)
            error.status = response.status
            error.retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status)
            throw error
        }
        let blob = await response.blob()
        if (hasRange && response.status !== 206) {
            // 有些 CDN 会忽略 Range 请求并返回 200，此时从完整响应中截取目标区间。
            if (blob.size >= segment.rangeEnd + 1) {
                blob = blob.slice(segment.rangeStart, segment.rangeEnd + 1, blob.type)
            } else if (blob.size !== rangeLength) {
                throw new Error('第 ' + ((segment.index || 0) + 1) + ' 个分片的字节范围无效')
            }
        }
        if (hasRange && blob.size !== rangeLength) {
            throw new Error('第 ' + ((segment.index || 0) + 1) + ' 个分片长度不完整')
        }
        return blob
    }

    function waitVideoRetry(delay, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) {
                reject(new DOMException('下载已取消', 'AbortError'))
                return
            }
            let timer = null
            const onAbort = () => {
                if (timer) clearTimeout(timer)
                signal && signal.removeEventListener('abort', onAbort)
                reject(new DOMException('下载已取消', 'AbortError'))
            }
            timer = setTimeout(() => {
                signal && signal.removeEventListener('abort', onAbort)
                resolve()
            }, delay)
            signal && signal.addEventListener('abort', onAbort, { once: true })
        })
    }

    async function fetchVideoSegmentWithRetry(segment, runtime, controls) {
        let attempt = 0
        while (!runtime.clearing) {
            try {
                return await fetchVideoSegment(segment, runtime.controller.signal)
            } catch (error) {
                if (runtime.clearing || runtime.controller.signal.aborted) throw error
                attempt++
                const retryable = error.retryable !== false
                if (!retryable && attempt >= VIDEO_NON_RETRYABLE_MAX_ATTEMPTS) throw error
                const delay = Math.min(
                    VIDEO_RETRY_MAX_DELAY,
                    VIDEO_RETRY_BASE_DELAY * Math.pow(2, Math.min(attempt - 1, 5))
                )
                const segmentNumber = (segment.index || 0) + 1
                controls.progress.textContent = '第 ' + segmentNumber + ' 个分片网络波动，' +
                    Math.ceil(delay / 1000) + ' 秒后自动重试（第 ' + attempt + ' 次）'
                await waitVideoRetry(delay, runtime.controller.signal)
            }
        }
        throw new Error('下载已取消')
    }

    function getVideoSegment(jobId, index) {
        return runVideoCacheTransaction(VIDEO_SEGMENT_STORE, 'readonly', store => {
            return store.get([jobId, index])
        }).then(item => item && item.blob)
    }

    function getVideoSegmentIndexes(jobId) {
        const range = IDBKeyRange.bound([jobId, 0], [jobId, Number.MAX_SAFE_INTEGER])
        return runVideoCacheTransaction(VIDEO_SEGMENT_STORE, 'readonly', store => {
            return store.getAllKeys(range)
        }).then(keys => (keys || []).map(key => key[1]))
    }

    function clearVideoJob(jobId) {
        const range = IDBKeyRange.bound([jobId, 0], [jobId, Number.MAX_SAFE_INTEGER])
        return runVideoCacheTransaction([VIDEO_JOB_STORE, VIDEO_SEGMENT_STORE], 'readwrite', (jobs, segments) => {
            jobs.delete(jobId)
            segments.delete(range)
        })
    }

    function getVideoCacheOverview() {
        return runVideoCacheTransaction([VIDEO_JOB_STORE, VIDEO_SEGMENT_STORE], 'readonly', (jobsStore, segmentsStore) => {
            const overview = { jobs: [], bytes: 0, segments: 0, bytesByJob: new Map() }
            const jobsById = new Map()
            const jobsRequest = jobsStore.openCursor()
            jobsRequest.onsuccess = () => {
                const cursor = jobsRequest.result
                if (!cursor) return
                const job = { ...cursor.value, bytes: 0, cachedSegments: 0 }
                jobsById.set(job.id, job)
                overview.jobs.push(job)
                cursor.continue()
            }
            const segmentsRequest = segmentsStore.openCursor()
            segmentsRequest.onsuccess = () => {
                const cursor = segmentsRequest.result
                if (!cursor) return
                const record = cursor.value || {}
                const size = record.blob && Number(record.blob.size) || 0
                overview.bytes += size
                overview.segments += 1
                overview.bytesByJob.set(record.jobId, (overview.bytesByJob.get(record.jobId) || 0) + size)
                const job = jobsById.get(record.jobId)
                if (job) job.cachedSegments += 1
                cursor.continue()
            }
            return { result: overview }
        }).then(async overview => {
            overview.jobs.forEach(job => { job.bytes = overview.bytesByJob.get(job.id) || 0 })
            overview.bytesByJob.clear()
            delete overview.bytesByJob
            if (navigator.storage && typeof navigator.storage.estimate === 'function') {
                try {
                    const estimate = await navigator.storage.estimate()
                    overview.quota = Number(estimate.quota) || 0
                    overview.usage = Number(estimate.usage) || 0
                    overview.usageRatio = overview.quota > 0 ? overview.usage / overview.quota : 0
                } catch (error) {
                    overview.quota = 0
                    overview.usage = 0
                    overview.usageRatio = 0
                }
            }
            return overview
        })
    }

    function formatVideoBytes(bytes) {
        const value = Number(bytes) || 0
        if (value < 1024) return value + ' B'
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
        if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
        return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }

    function formatVideoHistoryTime(timestamp) {
        const value = Number(timestamp)
        if (!Number.isFinite(value) || value <= 0) return '时间未知'
        try {
            return new Date(value).toLocaleString('zh-CN', { hour12: false })
        } catch (error) {
            return '时间未知'
        }
    }

    function getVideoHistoryStatus(job) {
        if (job.status === 'completed' && job.cachedSegments >= job.total) return '已完成'
        if (job.status === 'downloading') return '下载中'
        if (job.status === 'paused') return '已暂停'
        return job.status || '未知状态'
    }

    function openBrowserDownloads() {
        const userAgent = String(navigator.userAgent || '')
        const url = /Edg\//i.test(userAgent) ? 'edge://downloads/' : 'chrome://downloads/'
        try {
            if (typeof GM_openInTab === 'function') {
                const tab = GM_openInTab(url, { active: true, insert: true })
                if (tab) return
            }
        } catch (error) {
            console.warn('[MissAV 下载] 无法打开浏览器下载列表：', error)
        }
        try {
            window.open(url, '_blank', 'noopener')
        } catch (error) {
            console.warn('[MissAV 下载] 浏览器阻止了下载列表页面：', error)
        }
    }

    function renderRecentVideoHistory(overview, fileInfo, controls) {
        const history = controls && controls.history
        if (!history) return
        const jobs = (overview.jobs || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        const limit = controls.historyLimit || VIDEO_HISTORY_PAGE_SIZE
        history.list.textContent = ''
        if (!jobs.length) {
            history.empty.textContent = '暂无下载历史'
            history.empty.style.display = ''
        } else {
            history.empty.style.display = 'none'
            jobs.slice(0, limit).forEach(job => {
                const row = document.createElement('div')
                row.className = 'missav-video-history-row'
                const main = document.createElement('div')
                main.className = 'missav-video-history-main'
                const title = document.createElement('div')
                title.className = 'missav-video-history-title'
                title.textContent = (job.filename || '未命名视频') + (job.id === fileInfo.jobId ? '（当前）' : '')
                const meta = document.createElement('div')
                meta.className = 'missav-video-history-meta'
                meta.textContent = getVideoHistoryStatus(job) + ' · ' +
                    formatVideoBytes(job.bytes) + ' · ' +
                    (job.cachedSegments || 0) + '/' + (job.total || 0) + ' 分片 · ' +
                    formatVideoHistoryTime(job.updatedAt)
                main.appendChild(title)
                main.appendChild(meta)
                const openButton = document.createElement('button')
                openButton.className = 'missav-video-history-open'
                openButton.type = 'button'
                openButton.textContent = '下载列表'
                openButton.title = '打开浏览器下载列表，再选择“在文件夹中显示”'
                openButton.addEventListener('click', openBrowserDownloads)
                row.appendChild(main)
                row.appendChild(openButton)
                history.list.appendChild(row)
            })
        }
        const remaining = Math.max(0, jobs.length - limit)
        history.moreButton.style.display = remaining > 0 ? '' : 'none'
        history.moreButton.textContent = remaining > 0 ? '加载更多（还有 ' + remaining + ' 条）' : '加载更多'
    }

    async function refreshVideoCacheSummary(fileInfo, controls) {
        if (!controls || !controls.cacheHint) return
        try {
            const overview = await getVideoCacheOverview()
            const usageHint = overview.usageRatio >= 0.8 ? ' · 空间占用偏高' : ''
            controls.cacheHint.textContent = '当前任务 ' + fileInfo.segments.length + ' 个分片 · 共 ' +
                overview.jobs.length + ' 个缓存任务 · ' + formatVideoBytes(overview.bytes) + usageHint
            renderRecentVideoHistory(overview, fileInfo, controls)
        } catch (error) {
            controls.cacheHint.textContent = fileInfo.segments.length + ' 个分片 · 支持刷新续传'
        }
    }

    async function clearOtherVideoCache(keepJobId, fileInfo, controls) {
        try {
            const overview = await getVideoCacheOverview()
            const candidates = overview.jobs
                .filter(job => job.id !== keepJobId && !activeVideoDownloads.has(job.id) && job.status !== 'downloading')
                .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
            if (!candidates.length) {
                controls.progress.textContent = '没有可清理的其他缓存任务'
                return
            }
            const candidateBytes = candidates.reduce((sum, job) => sum + (job.bytes || 0), 0)
            const confirmed = window.confirm('将清理 ' + candidates.length + ' 个旧缓存任务（约 ' + formatVideoBytes(candidateBytes) + '）。\n当前视频缓存会保留，是否继续？')
            if (!confirmed) return
            for (const job of candidates) await clearVideoJob(job.id)
            notifyVideoCacheChanged('clear-other', keepJobId)
            controls.progress.textContent = '已清理 ' + candidates.length + ' 个旧缓存任务，释放约 ' + formatVideoBytes(candidateBytes)
            await refreshVideoCacheSummary(fileInfo, controls)
        } catch (error) {
            controls.progress.textContent = '清理旧缓存失败：' + (error.message || error)
        }
    }

    function safeVideoFilename(name) {
        return (name || 'missav_video')
            .replace(/[\\/:*?"<>|]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 120) || 'missav_video'
    }

    function updateVideoControls(controls, text, color, disabled) {
        controls.downloadButton.textContent = text
        controls.downloadButton.disabled = Boolean(disabled)
        controls.downloadButton.style.backgroundColor = color
    }

    function formatVideoElapsed(milliseconds) {
        const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000))
        if (totalSeconds < 60) return totalSeconds + ' 秒'
        const minutes = Math.floor(totalSeconds / 60)
        const seconds = String(totalSeconds % 60).padStart(2, '0')
        return minutes + ' 分 ' + seconds + ' 秒'
    }

    function runVideoStageWithTimeout(task, options) {
        const settings = options || {}
        const runtime = settings.runtime || {}
        const parentSignal = runtime.controller && runtime.controller.signal
        const stageController = new AbortController()
        const stageRuntime = { controller: stageController, clearing: Boolean(runtime.clearing) }
        const startedAt = Date.now()
        const timeoutMs = Math.max(1000, Number(settings.timeoutMs) || 15 * 60 * 1000)
        const heartbeatMs = Math.max(250, Number(settings.heartbeatMs) || 1000)

        return new Promise((resolve, reject) => {
            let settled = false
            let timeoutId = null
            let heartbeatId = null
            let parentAbortHandler = null

            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId)
                if (heartbeatId) clearInterval(heartbeatId)
                if (parentSignal && parentAbortHandler) {
                    parentSignal.removeEventListener('abort', parentAbortHandler)
                }
            }
            const settle = (handler, value) => {
                if (settled) return
                settled = true
                cleanup()
                handler(value)
            }
            const label = settings.label || '当前处理阶段'

            parentAbortHandler = () => {
                try { stageController.abort() } catch (_) {}
                settle(reject, new Error('下载已取消'))
            }
            if (parentSignal) {
                if (parentSignal.aborted) {
                    parentAbortHandler()
                    return
                }
                parentSignal.addEventListener('abort', parentAbortHandler, { once: true })
            }

            timeoutId = setTimeout(() => {
                if (settled) return
                if (typeof settings.onTimeout === 'function') {
                    try { settings.onTimeout(stageRuntime) } catch (_) {}
                }
                try { stageController.abort() } catch (_) {}
                settle(reject, new Error(label + '超时，缓存已保留，请点击“重新导出”重试'))
            }, timeoutMs)

            heartbeatId = setInterval(() => {
                if (settled || !settings.controls || !settings.controls.progress) return
                if (typeof settings.heartbeat === 'function') {
                    settings.heartbeat({
                        runtime: stageRuntime,
                        elapsedMs: Date.now() - startedAt,
                        label: label
                    })
                    return
                }
                settings.controls.progress.textContent = label + '（已用时 ' +
                    formatVideoElapsed(Date.now() - startedAt) + '，仍在处理）'
            }, heartbeatMs)

            Promise.resolve()
                .then(() => task(stageRuntime))
                .then(value => settle(resolve, value), error => settle(reject, error))
        })
    }

    function getMuxJs() {
        const candidate = typeof muxjs !== 'undefined'
            ? muxjs
            : (typeof window !== 'undefined' ? window.muxjs : null)
        return candidate && candidate.mp4 && typeof candidate.mp4.Transmuxer === 'function'
            ? candidate
            : null
    }

    // mux.js 输出的是 fragmented MP4（moov/mvex + 多个 moof/mdat）。
    // 115 的转码入口对这类文件兼容性不稳定，因此导出前做一次无损整理。
    const FFMPEG_CORE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm'
    const FFMPEG_LIBRARY_ESM_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm'
    const FFMPEG_MODULE_WORKER_SOURCE_URL = FFMPEG_LIBRARY_ESM_BASE_URL + '/worker.js'
    const FFMPEG_MAX_INPUT_BYTES = 1536 * 1024 * 1024
    const ffmpegState = {
        instance: null,
        loadPromise: null,
        objectUrls: [],
        queue: Promise.resolve(),
        active: null
    }

    function resetFfmpegState(instance) {
        const target = instance || ffmpegState.instance
        if (target && typeof target.terminate === 'function') {
            try { target.terminate() } catch (_) {}
        }
        if (!instance || ffmpegState.instance === target) {
            ffmpegState.instance = null
            ffmpegState.loadPromise = null
            for (const objectUrl of ffmpegState.objectUrls.splice(0)) {
                try { URL.revokeObjectURL(objectUrl) } catch (_) {}
            }
        }
    }

    function deleteFfmpegFileSafely(ffmpeg, filename) {
        if (!ffmpeg || typeof ffmpeg.deleteFile !== 'function') return Promise.resolve()
        return Promise.race([
            Promise.resolve().then(() => ffmpeg.deleteFile(filename)).catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 5000))
        ])
    }

    function isVideoRuntimeCancelled(runtime) {
        return Boolean(runtime && (runtime.clearing || (runtime.controller && runtime.controller.signal.aborted)))
    }

    function getFfmpegConstructor() {
        const candidate = typeof FFmpegWASM !== 'undefined'
            ? FFmpegWASM
            : (typeof window !== 'undefined' ? window.FFmpegWASM : null)
        return candidate && typeof candidate.FFmpeg === 'function' ? candidate.FFmpeg : null
    }

    async function fetchFfmpegBlobUrl(url, contentType, runtime) {
        const response = await fetch(url, {
            mode: 'cors',
            cache: 'force-cache',
            signal: runtime && runtime.controller ? runtime.controller.signal : undefined
        })
        if (!response.ok) throw new Error('加载 MP4 整理组件失败：HTTP ' + response.status)
        const data = await response.arrayBuffer()
        const blobUrl = URL.createObjectURL(new Blob([data], { type: contentType }))
        ffmpegState.objectUrls.push(blobUrl)
        return blobUrl
    }

    function rewriteFfmpegModuleWorkerSource(source, baseUrl) {
        const normalizedBaseUrl = String(baseUrl || '').replace(/\/$/, '')
        return String(source || '')
            .replace(/from\s+(["'])\.\/const\.js\1/g, 'from "' + normalizedBaseUrl + '/const.js"')
            .replace(/from\s+(["'])\.\/errors\.js\1/g, 'from "' + normalizedBaseUrl + '/errors.js"')
    }

    async function fetchFfmpegModuleWorkerUrl(runtime) {
        const response = await fetch(FFMPEG_MODULE_WORKER_SOURCE_URL, {
            mode: 'cors',
            cache: 'force-cache',
            signal: runtime && runtime.controller ? runtime.controller.signal : undefined
        })
        if (!response.ok) throw new Error('加载 MP4 Worker 组件失败：HTTP ' + response.status)
        const source = await response.text()
        const rewrittenSource = rewriteFfmpegModuleWorkerSource(source, FFMPEG_LIBRARY_ESM_BASE_URL)
        const blobUrl = URL.createObjectURL(new Blob([rewrittenSource], { type: 'text/javascript' }))
        ffmpegState.objectUrls.push(blobUrl)
        return blobUrl
    }

    async function getFfmpeg(runtime) {
        if (ffmpegState.instance && ffmpegState.instance.loaded) return ffmpegState.instance
        if (ffmpegState.loadPromise) return ffmpegState.loadPromise

        ffmpegState.loadPromise = (async () => {
            const Ffmpeg = getFfmpegConstructor()
            if (!Ffmpeg) throw new Error('MP4 整理组件未加载，请确认脚本的 FFmpeg 依赖已成功加载后重试')
            const ffmpeg = new Ffmpeg()
            ffmpegState.instance = ffmpeg
            ffmpeg.on('progress', event => {
                const active = ffmpegState.active
                if (!active || !active.controls || isVideoRuntimeCancelled(active.runtime)) return
                const progress = Number(event && event.progress)
                if (Number.isFinite(progress) && progress >= 0) {
                    active.lastProgressAt = Date.now()
                    active.controls.progress.textContent = '正在整理为 115 兼容 MP4：' + Math.min(100, Math.round(progress * 100)) + '%'
                }
            })
            const signal = runtime && runtime.controller ? runtime.controller.signal : undefined
            const terminateOnAbort = () => resetFfmpegState(ffmpeg)
            if (signal) {
                if (signal.aborted) terminateOnAbort()
                else signal.addEventListener('abort', terminateOnAbort, { once: true })
            }
            try {
                const coreURL = await fetchFfmpegBlobUrl(FFMPEG_CORE_BASE_URL + '/ffmpeg-core.js', 'text/javascript', runtime)
                const wasmURL = await fetchFfmpegBlobUrl(FFMPEG_CORE_BASE_URL + '/ffmpeg-core.wasm', 'application/wasm', runtime)
                const classWorkerURL = await fetchFfmpegModuleWorkerUrl(runtime)
                await ffmpeg.load({
                    coreURL: coreURL,
                    wasmURL: wasmURL,
                    classWorkerURL: classWorkerURL
                }, { signal: signal })
                return ffmpeg
            } finally {
                if (signal) signal.removeEventListener('abort', terminateOnAbort)
            }
        })()

        try {
            return await ffmpegState.loadPromise
        } catch (error) {
            resetFfmpegState()
            throw error
        }
    }

    function queueFfmpegTask(task) {
        const run = ffmpegState.queue.then(task, task)
        ffmpegState.queue = run.catch(() => {})
        return run
    }

    function hasMp4Box(bytes, name) {
        if (!bytes || bytes.byteLength < 12) return false
        for (let offset = 4; offset + 4 <= bytes.byteLength; offset++) {
            if (bytes[offset] !== name.charCodeAt(0) ||
                bytes[offset + 1] !== name.charCodeAt(1) ||
                bytes[offset + 2] !== name.charCodeAt(2) ||
                bytes[offset + 3] !== name.charCodeAt(3)) continue
            const sizeOffset = offset - 4
            const size = new DataView(bytes.buffer, bytes.byteOffset + sizeOffset, 4).getUint32(0)
            if (size === 0 || (size >= 8 && sizeOffset + size <= bytes.byteLength)) return true
            if (size === 1 && sizeOffset + 16 <= bytes.byteLength) return true
        }
        return false
    }

    async function isFragmentedMp4(blob) {
        const probeSize = Math.min(blob.size, 8 * 1024 * 1024)
        const bytes = new Uint8Array(await blob.slice(0, probeSize).arrayBuffer())
        return hasMp4Box(bytes, 'mvex') || hasMp4Box(bytes, 'moof')
    }

    async function remuxFragmentedMp4ToProgressiveMp4(inputBlob, controls, runtime) {
        if (isVideoRuntimeCancelled(runtime)) throw new Error('下载已取消')

        if (inputBlob.size > FFMPEG_MAX_INPUT_BYTES) {
            controls.progress.textContent = '文件过大，已直接导出原始 MP4；未进行浏览器兼容整理'
            return { blob: inputBlob, compatible: false, tooLarge: true }
        }

        const timeoutMs = Math.min(
            15 * 60 * 1000,
            Math.max(3 * 60 * 1000, 3 * 60 * 1000 + Math.ceil(inputBlob.size / (8 * 1024 * 1024)) * 1000)
        )
        return queueFfmpegTask(async () => {
            const inputName = 'missav-fragmented-input.mp4'
            const outputName = 'missav-progressive-output.mp4'
            const active = { controls: controls, runtime: runtime, lastProgressAt: 0 }
            let ffmpeg = null
            let stageAbortHandler = null
            let stageSignal = null
            ffmpegState.active = active
            try {
                return await runVideoStageWithTimeout(async stageRuntime => {
                    stageAbortHandler = () => resetFfmpegState(ffmpeg || ffmpegState.instance)
                    stageSignal = stageRuntime.controller.signal
                    stageSignal.addEventListener('abort', stageAbortHandler, { once: true })
                    const ffmpegRuntime = {
                        controller: stageRuntime.controller,
                        clearing: Boolean(runtime && runtime.clearing)
                    }
                    controls.progress.textContent = '正在加载 MP4 整理组件…首次使用会加载约 31 MB 组件'
                    ffmpeg = await getFfmpeg(ffmpegRuntime)
                    if (isVideoRuntimeCancelled(runtime)) throw new Error('下载已取消')
                    controls.progress.textContent = '正在整理为 115 兼容 MP4：准备输入数据'
                    await deleteFfmpegFileSafely(ffmpeg, inputName)
                    await deleteFfmpegFileSafely(ffmpeg, outputName)
                    const inputBytes = new Uint8Array(await inputBlob.arrayBuffer())
                    if (isVideoRuntimeCancelled(runtime)) throw new Error('下载已取消')
                    controls.progress.textContent = '正在整理为 115 兼容 MP4：写入输入数据'
                    await ffmpeg.writeFile(inputName, inputBytes)
                    controls.progress.textContent = '正在整理为 115 兼容 MP4：开始无损整理'
                    await ffmpeg.exec([
                        '-i', inputName,
                        '-map', '0:v:0',
                        '-map', '0:a?',
                        '-c', 'copy',
                        '-avoid_negative_ts', 'make_zero',
                        '-movflags', '+faststart',
                        outputName
                    ], -1, { signal: stageRuntime.controller.signal })
                    if (isVideoRuntimeCancelled(runtime)) throw new Error('下载已取消')
                    controls.progress.textContent = '正在整理为 115 兼容 MP4：读取输出文件'
                    const outputBytes = await ffmpeg.readFile(outputName)
                    if (!outputBytes || !outputBytes.byteLength) throw new Error('MP4 整理失败：没有生成输出文件')
                    const view = outputBytes instanceof Uint8Array
                        ? outputBytes
                        : new Uint8Array(outputBytes)
                    return { blob: new Blob([view], { type: 'video/mp4' }), compatible: true, tooLarge: false }
                }, {
                    runtime: runtime,
                    controls: controls,
                    label: 'MP4 整理',
                    timeoutMs: timeoutMs,
                    heartbeat: heartbeat => {
                        const state = ffmpegState.active
                        if (state && state.lastProgressAt && Date.now() - state.lastProgressAt < 3000) return
                        controls.progress.textContent = 'MP4 整理中（已用时 ' +
                            formatVideoElapsed(heartbeat.elapsedMs) + '，浏览器仍在处理）'
                    },
                    onTimeout: () => {
                        resetFfmpegState(ffmpeg || ffmpegState.instance)
                        if (ffmpegState.active === active) ffmpegState.active = null
                    }
                })
            } catch (error) {
                if (isVideoRuntimeCancelled(runtime) || (error && error.name === 'AbortError')) {
                    throw new Error('下载已取消')
                }
                throw new Error('MP4 整理失败：' + (error && error.message ? error.message : error))
            } finally {
                if (stageSignal && stageAbortHandler) {
                    stageSignal.removeEventListener('abort', stageAbortHandler)
                }
                if (ffmpegState.active === active) ffmpegState.active = null
                await deleteFfmpegFileSafely(ffmpeg, inputName)
                await deleteFfmpegFileSafely(ffmpeg, outputName)
            }
        })
    }

    async function transmuxTsToMp4(blobs, controls, runtime) {
        const mux = getMuxJs()
        if (!mux) {
            throw new Error('TS 转 MP4 组件未加载，请确认脚本的 mux.js 依赖已成功加载后重试')
        }

        const outputChunks = []
        let initSegmentAdded = false
        let transmuxError = null
        const transmuxer = new mux.mp4.Transmuxer({
            remux: true,
            keepOriginalTimestamps: false
        })

        transmuxer.on('data', segment => {
            if (!initSegmentAdded && segment.initSegment && segment.initSegment.byteLength) {
                outputChunks.push(new Uint8Array(segment.initSegment))
                initSegmentAdded = true
            }
            if (segment.data && segment.data.byteLength) {
                outputChunks.push(new Uint8Array(segment.data))
            }
        })
        transmuxer.on('error', error => {
            transmuxError = error instanceof Error ? error : new Error(String(error || '未知转封装错误'))
        })

        for (let i = 0; i < blobs.length; i++) {
            if (isVideoRuntimeCancelled(runtime)) throw new Error('下载已取消')
            controls.progress.textContent = '正在转换 MP4 ' + (i + 1) + '/' + blobs.length + ' 个分片'
            const bytes = new Uint8Array(await blobs[i].arrayBuffer())
            if (bytes.byteLength) {
                transmuxer.push(bytes)
                // 按 HLS 分片输出独立的 moof/mdat，保留关键帧边界，避免快进时从错误帧开始解码。
                transmuxer.flush()
            }
            if (transmuxError) throw new Error('TS 转 MP4 失败：' + transmuxError.message)
        }
        if (isVideoRuntimeCancelled(runtime)) throw new Error('下载已取消')
        if (transmuxError) throw new Error('TS 转 MP4 失败：' + transmuxError.message)
        if (!outputChunks.length || !initSegmentAdded) {
            throw new Error('TS 转 MP4 失败：没有生成有效的 MP4 数据')
        }
        return new Blob(outputChunks, { type: 'video/mp4' })
    }

    async function exportCachedVideo(job, controls, runtime) {
        updateVideoControls(controls, '正在合并...', 'lightyellow', true)
        controls.progress.textContent = '正在从缓存生成文件'
        const blobs = []
        for (let i = 0; i < job.segments.length; i++) {
            if (isVideoRuntimeCancelled(runtime)) throw new Error('下载已取消')
            if (i === 0 || (i + 1) % 10 === 0 || i + 1 === job.segments.length) {
                controls.progress.textContent = '正在读取缓存 ' + (i + 1) + '/' + job.segments.length + ' 个分片'
            }
            const blob = await getVideoSegment(job.id, i)
            if (!blob) throw new Error('缓存中缺少第 ' + (i + 1) + ' 个分片')
            blobs.push(blob)
        }
        if (isVideoRuntimeCancelled(runtime)) throw new Error('下载已取消')
        controls.progress.textContent = '正在拼接 ' + blobs.length + ' 个分片'
        const assembledBlob = job.container === 'ts'
            ? await transmuxTsToMp4(blobs, controls, runtime)
            : new Blob(blobs, { type: 'video/mp4' })
        blobs.length = 0
        if (isVideoRuntimeCancelled(runtime)) throw new Error('下载已取消')
        const fragmented = await isFragmentedMp4(assembledBlob)
        const remuxResult = fragmented
            ? await remuxFragmentedMp4ToProgressiveMp4(assembledBlob, controls, runtime)
            : { blob: assembledBlob, compatible: true, tooLarge: false }
        const outputBlob = remuxResult.blob
        if (fragmented && remuxResult.compatible && await isFragmentedMp4(outputBlob)) {
            throw new Error('MP4 整理失败：输出仍是分片 MP4，缓存已保留')
        }
        const blobUrl = URL.createObjectURL(outputBlob)
        const link = document.createElement('a')
        link.href = blobUrl
        const filename = safeVideoFilename(job.filename).replace(/\.(?:mp4|ts)$/i, '')
        link.download = filename + '.mp4'
        document.body.appendChild(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000)
        updateVideoControls(controls, '重新导出', 'lightgreen', false)
        controls.progress.textContent = remuxResult.tooLarge
            ? '已完成（原始 MP4）；文件过大，未进行浏览器兼容整理，上传 115 可能仍需桌面 FFmpeg；缓存仍保留'
            : fragmented
                ? '已完成（普通 MP4），缓存仍保留；不需要时点击“清除缓存”'
                : '已完成（MP4），缓存仍保留；不需要时点击“清除缓存”'
    }

    async function startOrResumeVideoDownload(fileInfo, controls) {
        const jobId = fileInfo.jobId
        if (activeVideoDownloads.has(jobId)) return
        const runtime = { controller: new AbortController(), clearing: false, manualPause: false, resolveDone: null }
        runtime.done = new Promise(resolve => { runtime.resolveDone = resolve })
        activeVideoDownloads.set(jobId, runtime)
        try {
            let job = await getVideoJob(jobId)
            if (!job) {
                job = {
                    id: jobId,
                    playlistUrl: fileInfo.url,
                    filename: fileInfo.filename,
                    segments: fileInfo.segments,
                    total: fileInfo.segments.length,
                    completed: 0,
                    container: fileInfo.container,
                    segmentSignature: fileInfo.segmentSignature,
                    status: 'paused',
                    updatedAt: Date.now()
                }
            } else {
                job.playlistUrl = fileInfo.url
                job.filename = fileInfo.filename
                job.segments = fileInfo.segments
                job.total = fileInfo.segments.length
                job.container = fileInfo.container
                job.segmentSignature = fileInfo.segmentSignature
            }

            const cachedIndexes = new Set(await getVideoSegmentIndexes(jobId))
            if (job.status === 'completed' && cachedIndexes.size === job.total) {
                await exportCachedVideo(job, controls, runtime)
                return
            }

            job.status = 'downloading'
            job.completed = cachedIndexes.size
            job.updatedAt = Date.now()
            await saveVideoJob(job)
            notifyVideoCacheChanged('downloading', jobId)
            await refreshVideoCacheSummary(fileInfo, controls)
            updateVideoControls(controls, '暂停下载', 'lightgreen', false)
            controls.progress.textContent = '已缓存 ' + job.completed + '/' + job.total + ' 个分片'

            // 分片并发下载；每个分片完成后仍立即写入 IndexedDB，确保刷新后可以续传。
            let nextIndex = 0
            let workerError = null
            const downloadWorker = async () => {
                try {
                    while (true) {
                        if (runtime.clearing) throw new Error('下载已取消')
                        const i = nextIndex++
                        if (i >= job.segments.length) return
                        if (cachedIndexes.has(i)) continue

                        const segment = job.segments[i]
                        const blob = await fetchVideoSegmentWithRetry(segment, runtime, controls)
                        await saveVideoSegment(jobId, i, blob)
                        cachedIndexes.add(i)
                        job.completed = cachedIndexes.size
                        job.updatedAt = Date.now()
                        updateVideoControls(controls, '暂停下载', 'lightgreen', false)
                        controls.progress.textContent = '已缓存 ' + job.completed + '/' + job.total + ' 个分片（' + VIDEO_DOWNLOAD_CONCURRENCY + ' 路并发）'
                    }
                } catch (error) {
                    if (!runtime.clearing && !workerError) {
                        workerError = error
                        runtime.controller.abort()
                    }
                    throw error
                }
            }
            const workerCount = Math.min(
                VIDEO_DOWNLOAD_CONCURRENCY,
                Math.max(1, job.segments.length - cachedIndexes.size)
            )
            try {
                await Promise.all(Array.from({ length: workerCount }, () => downloadWorker()))
            } catch (error) {
                throw workerError || error
            }

            job.status = 'completed'
            job.completed = job.total
            job.updatedAt = Date.now()
            await saveVideoJob(job)
            notifyVideoCacheChanged('completed', jobId)
            await refreshVideoCacheSummary(fileInfo, controls)
            await exportCachedVideo(job, controls, runtime)
        } catch (error) {
            if (!runtime.clearing) {
                const job = await getVideoJob(jobId).catch(() => null)
                if (runtime.manualPause) {
                    if (job && job.status !== 'completed') {
                        job.status = 'paused'
                        job.updatedAt = Date.now()
                        await saveVideoJob(job).catch(() => {})
                    }
                    updateVideoControls(controls, '继续下载', 'lightyellow', false)
                    controls.progress.textContent = '已手动暂停，缓存已保留；点击“继续下载”恢复'
                } else if (job && job.status !== 'completed') {
                    job.status = 'paused'
                    job.updatedAt = Date.now()
                    await saveVideoJob(job).catch(() => {})
                    updateVideoControls(controls, '继续下载', 'lightyellow', false)
                    controls.progress.textContent = '已暂停，刷新页面后可继续；' + (error.message || error)
                } else if (job && job.status === 'completed') {
                    updateVideoControls(controls, '重新导出', 'lightyellow', false)
                    controls.progress.textContent = '缓存已完整，但导出失败：' + (error.message || error) + '；缓存仍保留，可重试'
                } else {
                    updateVideoControls(controls, '继续下载', 'lightyellow', false)
                    controls.progress.textContent = '已暂停，刷新页面后可继续；' + (error.message || error)
                }
                notifyVideoCacheChanged(runtime.manualPause ? 'paused' : 'error', jobId)
                await refreshVideoCacheSummary(fileInfo, controls)
                console.error('[MissAV 下载]', error)
            }
        } finally {
            if (activeVideoDownloads.get(jobId) === runtime) {
                activeVideoDownloads.delete(jobId)
            }
            if (runtime.resolveDone) runtime.resolveDone()
        }
    }

    async function pauseVideoDownload(fileInfo) {
        const runtime = activeVideoDownloads.get(fileInfo.jobId)
        if (!runtime) return
        runtime.manualPause = true
        runtime.controller.abort()
        await runtime.done.catch(() => {})
    }

    async function restoreVideoDownload(fileInfo, controls) {
        try {
            const job = await getVideoJob(fileInfo.jobId)
            if (!job) return
            const cachedCount = (await getVideoSegmentIndexes(fileInfo.jobId)).length
            if (job.status === 'completed' && cachedCount === fileInfo.segments.length) {
                updateVideoControls(controls, '重新导出', 'lightgreen', false)
                controls.progress.textContent = '已有完整缓存，点击“重新导出”即可生成文件'
                return
            }
            updateVideoControls(controls, '恢复下载', 'lightyellow', false)
            controls.progress.textContent = '检测到上次下载：已缓存 ' + cachedCount + '/' + fileInfo.segments.length + ' 个分片，正在继续'
            startOrResumeVideoDownload(fileInfo, controls)
        } catch (error) {
            console.warn('[MissAV 下载] 读取下载缓存失败：', error)
        }
    }

    async function clearVideoDownload(fileInfo, controls) {
        const runtime = activeVideoDownloads.get(fileInfo.jobId)
        if (runtime) {
            runtime.clearing = true
            runtime.controller.abort()
            activeVideoDownloads.delete(fileInfo.jobId)
            await runtime.done.catch(() => {})
        }
        try {
            await clearVideoJob(fileInfo.jobId)
            notifyVideoCacheChanged('clear-current', fileInfo.jobId)
            updateVideoControls(controls, '下载', 'lightgray', false)
            controls.progress.textContent = '对应视频缓存已清除'
            await refreshVideoCacheSummary(fileInfo, controls)
        } catch (error) {
            controls.progress.textContent = '清除缓存失败：' + (error.message || error)
        }
    }
    function ensureVideoDownloadStyles() {
        if (document.getElementById('missav-video-download-styles')) return
        const style = document.createElement('style')
        style.id = 'missav-video-download-styles'
        style.textContent = [
            '.missav-video-download-section{width:100%;box-sizing:border-box;margin-top:11px;padding-top:11px;border-top:1px solid rgba(245,158,11,.38);color:#e5eef7;}',
            '.missav-video-download-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}',
            '.missav-video-quality{display:inline-flex;align-items:center;gap:7px;color:#d7ffe3;font-size:15px;font-weight:800;}',
            '.missav-video-quality-badge{padding:4px 8px;border-radius:6px;background:#164e3b;color:#bbf7d0;}',
            '.missav-video-download-hint{color:#9fb4c8;font-size:11px;}',
            '.missav-video-download-status{display:block;min-height:18px;margin:9px 0;color:#b8d7e5;font-size:12px;line-height:1.5;}',
            '.missav-video-download-actions{display:flex;flex-wrap:wrap;gap:7px;}',
            '.missav-video-download-action{min-height:31px;padding:0 12px;border:0;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;transition:filter .15s,transform .15s;}',
            '.missav-video-download-action:hover{filter:brightness(1.08);transform:translateY(-1px);}',
            '.missav-video-download-primary{background:#38bdf8;color:#082f49;}',
            '.missav-video-download-clear{background:#7f1d1d;color:#fee2e2;}',
            '.missav-video-download-cache{background:#334155;color:#e2e8f0;}',
            '.missav-video-download-115{background:#60a5fa;color:#082f49;}',
            '.missav-video-history{margin-top:12px;padding-top:10px;border-top:1px solid rgba(148,163,184,.22);}',
            '.missav-video-history-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;color:#dbeafe;font-size:12px;font-weight:800;}',
            '.missav-video-history-empty{padding:7px 0;color:#8fa6b8;font-size:11px;}',
            '.missav-video-history-list{display:grid;gap:6px;}',
            '.missav-video-history-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 8px;border:1px solid rgba(148,163,184,.2);border-radius:6px;background:rgba(15,23,42,.42);}',
            '.missav-video-history-main{min-width:0;flex:1;}',
            '.missav-video-history-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e2e8f0;font-size:11px;}',
            '.missav-video-history-meta{margin-top:3px;color:#8fa6b8;font-size:10px;line-height:1.35;}',
            '.missav-video-history-open,.missav-video-history-more{min-height:26px;padding:0 9px;border:0;border-radius:5px;background:#475569;color:#e2e8f0;font-size:11px;cursor:pointer;white-space:nowrap;}',
            '.missav-video-history-open:hover,.missav-video-history-more:hover{filter:brightness(1.12);}',
            '.missav-video-history-more{display:block;margin:8px auto 0;background:#1d4ed8;color:#dbeafe;}',
            '.missav-video-history-actions{margin-top:8px;}',
            '@media (max-width:560px){.missav-video-download-actions{display:grid;grid-template-columns:1fr 1fr;}.missav-video-download-action{width:100%;}.missav-video-download-115{grid-column:1 / -1;}}'
        ].join('\n')
        document.head.appendChild(style)
    }

    // 新的下载卡片：只显示最高分辨率；视频地址复制按钮已移除。
    function createUrlElement(fileInfo) {
        ensureVideoDownloadStyles()
        const card = document.createElement('div')
        card.className = 'missav-video-download-section'

        const head = document.createElement('div')
        head.className = 'missav-video-download-head'
        const quality = document.createElement('div')
        quality.className = 'missav-video-quality'
        const qualityBadge = document.createElement('span')
        qualityBadge.className = 'missav-video-quality-badge'
        qualityBadge.textContent = fileInfo.display
        quality.appendChild(qualityBadge)
        const qualityText = document.createElement('span')
        qualityText.textContent = '最高分辨率'
        quality.appendChild(qualityText)
        head.appendChild(quality)
        const hint = document.createElement('span')
        hint.className = 'missav-video-download-hint'
        hint.textContent = fileInfo.segments.length + ' 个分片 · 支持刷新续传'
        head.appendChild(hint)
        card.appendChild(head)

        const progress = document.createElement('span')
        progress.className = 'missav-video-download-status'
        progress.textContent = '准备下载'
        card.appendChild(progress)

        const actions = document.createElement('div')
        actions.className = 'missav-video-download-actions'
        const downloadButton = document.createElement('button')
        downloadButton.className = 'missav-video-download-action missav-video-download-primary'
        downloadButton.textContent = '下载视频'
        actions.appendChild(downloadButton)

        const clearButton = document.createElement('button')
        clearButton.className = 'missav-video-download-action missav-video-download-clear'
        clearButton.textContent = '清除当前缓存'

        const cacheButton = document.createElement('button')
        cacheButton.className = 'missav-video-download-action missav-video-download-cache'
        cacheButton.textContent = '清理其他缓存'
        cacheButton.title = '保留当前任务，仅清理其他已暂停或已完成任务'

        const to115Button = document.createElement('button')
        to115Button.className = 'missav-video-download-action missav-video-download-115'
        to115Button.textContent = '转存 115'
        actions.appendChild(to115Button)
        card.appendChild(actions)

        const historySection = document.createElement('div')
        historySection.className = 'missav-video-history'
        const historyHead = document.createElement('div')
        historyHead.className = 'missav-video-history-head'
        const historyTitle = document.createElement('span')
        historyTitle.textContent = '近期下载历史'
        const historyHint = document.createElement('span')
        historyHint.textContent = '默认显示 3 条'
        historyHint.style.color = '#8fa6b8'
        historyHint.style.fontWeight = '500'
        historyHead.appendChild(historyTitle)
        historyHead.appendChild(historyHint)
        historySection.appendChild(historyHead)

        const historyEmpty = document.createElement('div')
        historyEmpty.className = 'missav-video-history-empty'
        historyEmpty.textContent = '正在读取下载历史...'
        historySection.appendChild(historyEmpty)
        const historyList = document.createElement('div')
        historyList.className = 'missav-video-history-list'
        historySection.appendChild(historyList)
        const historyMore = document.createElement('button')
        historyMore.className = 'missav-video-history-more'
        historyMore.type = 'button'
        historyMore.textContent = '加载更多'
        historyMore.style.display = 'none'
        historySection.appendChild(historyMore)

        const historyActions = document.createElement('div')
        historyActions.className = 'missav-video-download-actions missav-video-history-actions'
        historyActions.appendChild(clearButton)
        historyActions.appendChild(cacheButton)
        const downloadsButton = document.createElement('button')
        downloadsButton.className = 'missav-video-download-action missav-video-download-cache'
        downloadsButton.type = 'button'
        downloadsButton.textContent = '打开下载列表'
        downloadsButton.title = '打开浏览器下载列表，再选择“在文件夹中显示”'
        historyActions.appendChild(downloadsButton)
        historySection.appendChild(historyActions)
        card.appendChild(historySection)

        const controls = {
            downloadButton: downloadButton,
            clearButton: clearButton,
            cacheButton: cacheButton,
            cacheHint: hint,
            progress: progress,
            historyLimit: VIDEO_HISTORY_PAGE_SIZE,
            history: {
                empty: historyEmpty,
                list: historyList,
                moreButton: historyMore
            }
        }
        registerVideoHistoryControls(fileInfo, controls)
        downloadButton.addEventListener('click', () => {
            if (activeVideoDownloads.has(fileInfo.jobId)) {
                pauseVideoDownload(fileInfo)
            } else {
                startOrResumeVideoDownload(fileInfo, controls)
            }
        })
        clearButton.addEventListener('click', () => clearVideoDownload(fileInfo, controls))
        cacheButton.addEventListener('click', () => clearOtherVideoCache(fileInfo.jobId, fileInfo, controls))
        downloadsButton.addEventListener('click', openBrowserDownloads)
        historyMore.addEventListener('click', () => {
            controls.historyLimit += VIDEO_HISTORY_PAGE_SIZE
            refreshVideoCacheSummary(fileInfo, controls)
        })
        to115Button.addEventListener('click', () => submitTo115(fileInfo.url, to115Button))
        restoreVideoDownload(fileInfo, controls)
        refreshVideoCacheSummary(fileInfo, controls)
        return card
    }

    function detect115Runtime() {
        const userAgent = String(navigator.userAgent || '')
        const brands = navigator.userAgentData && Array.isArray(navigator.userAgentData.brands)
            ? navigator.userAgentData.brands.map(item => item.brand).join(' ')
            : ''
        const fingerprint = userAgent + ' ' + brands
        const is115Browser = /115Browser/i.test(fingerprint)
        const isEdge = !is115Browser && (/Edg\//i.test(userAgent) || /Microsoft Edge/i.test(brands))
        const isChrome = !is115Browser && !isEdge && (/Chrome|Chromium/i.test(userAgent) || /Google Chrome/i.test(brands))
        return {
            name: is115Browser ? '115浏览器' : isChrome ? 'Chrome' : isEdge ? 'Edge' : /Firefox/i.test(userAgent) ? 'Firefox' : '当前浏览器',
            is115Browser: is115Browser,
            isChrome: isChrome
        }
    }

    function show115Notice(message, type, duration) {
        const palette = {
            info: { background: '#0f3c52', border: '#38bdf8' },
            success: { background: '#14532d', border: '#4ade80' },
            warning: { background: '#713f12', border: '#fbbf24' },
            error: { background: '#7f1d1d', border: '#f87171' }
        }
        const colors = palette[type] || palette.info
        let notice = document.getElementById('missav-115-notice')
        if (!notice) {
            notice = document.createElement('div')
            notice.id = 'missav-115-notice'
            notice.setAttribute('role', 'status')
            notice.setAttribute('aria-live', 'polite')
            notice.style.cssText = 'position:fixed;top:18px;right:18px;z-index:2147483647;display:none;max-width:380px;padding:11px 14px;border:1px solid;border-radius:9px;color:#f8fafc;font:13px/1.55 Arial,sans-serif;white-space:pre-line;box-shadow:0 8px 24px rgba(0,0,0,.28);'
            ;(document.body || document.documentElement).appendChild(notice)
        }
        notice.textContent = message
        notice.setAttribute('role', type === 'error' ? 'alert' : 'status')
        notice.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite')
        notice.style.background = colors.background
        notice.style.borderColor = colors.border
        notice.style.display = 'block'
        clearTimeout(notice._hideTimer)
        notice._hideTimer = setTimeout(() => { notice.style.display = 'none' }, duration || 6000)
    }

    const OFFLINE_HANDOFF_KEY = 'missav115OfflineHandoff'
    function open115OfflineHandoff(taskUrl) {
        const target = 'https://115.com/web/lixian/master/magnet/?url=' + encodeURIComponent(taskUrl)
        if (typeof GM_openInTab === 'function') {
            GM_openInTab(target, { active: true, insert: true })
            return
        }
        const tab = window.open(target, '_blank')
        if (!tab) show115Notice('浏览器阻止了 115 离线页面，请允许弹出窗口后重试。', 'warning', 8000)
    }

    function handle115OfflineHandoff() {
        if (!/115\.com$/i.test(location.hostname)) return
        const currentUrl = new URL(location.href)
        const queryTask = currentUrl.searchParams.get('url')
        if (queryTask) {
            sessionStorage.setItem(OFFLINE_HANDOFF_KEY, queryTask)
            if (/\/web\/lixian\/master\/magnet\/?$/i.test(currentUrl.pathname)) {
                location.href = 'https://115.com/?cid=0&offset=0&mode=wangpan'
                return
            }
        }
        const taskUrl = sessionStorage.getItem(OFFLINE_HANDOFF_KEY)
        if (!taskUrl) return
        let attempts = 0
        const fillOfflineInput = () => {
            const input = document.querySelector('#js_offline_new_add') || document.querySelector('input[name="url"], textarea[name="url"]')
            if (!input) {
                attempts += 1
                if (attempts < 30) setTimeout(fillOfflineInput, 500)
                else show115Notice('已打开 115 离线页面，但没有找到输入框，请在当前浏览器登录 115 后重试。', 'warning', 9000)
                return
            }
            input.value = taskUrl
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
            sessionStorage.removeItem(OFFLINE_HANDOFF_KEY)
            show115Notice('磁力已预填到 115 离线下载，请确认后提交。', 'success', 7000)
        }
        setTimeout(fillOfflineInput, 300)
    }

    // 把指定地址提交到 115 网盘离线下载；只使用当前页面所在浏览器的登录状态。
    // Chrome 页面不能读取另一个 115 浏览器配置文件的 Cookie，因此失败时会明确给出处理路径。
    function submitTo115(taskUrl, btn) {
        const runtime = detect115Runtime()
        const restore = () => {
            btn.disabled = false
            btn.textContent = '转存115'
            btn.style.backgroundColor = ''
        }
        const fail = (msg, offerHandoff) => {
            console.error('[115 转存]', runtime.name, msg)
            const canHandoff = Boolean(offerHandoff && /^magnet:/i.test(taskUrl) && (runtime.isChrome || runtime.is115Browser))
            show115Notice('转存 115 失败（当前：' + runtime.name + '）\n' + msg +
                (canHandoff ? '\n正在打开当前浏览器的 115 离线页面并预填磁力…' : ''), canHandoff ? 'warning' : 'error', 10000)
            restore()
            if (canHandoff) setTimeout(() => open115OfflineHandoff(taskUrl), 250)
        }
        if (!/^magnet:/i.test(String(taskUrl || '').trim())) {
            restore()
            show115Notice('未检测到可用磁力链接，未提交到 115。\n请使用磁力结果卡片中的“转存115”按钮。', 'warning', 8000)
            return
        }
        if (typeof GM_xmlhttpRequest !== 'function') {
            fail('脚本没有 GM_xmlhttpRequest 权限，请重新安装/更新脚本。')
            return
        }
        btn.disabled = true
        btn.textContent = '检查 ' + runtime.name + ' 登录...'
        btn.style.backgroundColor = 'lightyellow'
        show115Notice('正在检查 ' + runtime.name + ' 的 115 登录状态…', 'info', 5000)
        // 第一步：取离线下载所需的 sign / time。
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://115.com/?ct=offline&ac=space&_=' + Date.now(),
            anonymous: false,
            onload: (res) => {
                let info
                try {
                    info = JSON.parse(res.responseText)
                } catch (e) {
                    return fail(runtime.isChrome
                        ? '当前 Chrome 没有可用的 115 登录状态。115 浏览器的登录 Cookie 不能被 Chrome 页面直接读取，请在 Chrome 登录 115，或改在 115 浏览器打开此页面后重试。'
                        : '当前浏览器没有可用的 115 登录状态，请先在当前浏览器登录 115 后重试。')
                }
                if (!info || !info.sign) {
                    return fail(runtime.isChrome
                        ? '当前 Chrome 未通过 115 登录检查。115 浏览器与 Chrome 的登录状态相互隔离，脚本不能直接借用另一个浏览器的 Cookie；请在 Chrome 登录 115，或在 115 浏览器中打开此页。'
                        : '当前浏览器未通过 115 登录检查，请先登录 115 后重试。')
                }
                // 第二步：提交离线任务
                btn.textContent = '转存中...'
                const body = 'url=' + encodeURIComponent(taskUrl) +
                    '&sign=' + encodeURIComponent(info.sign) +
                    '&time=' + info.time
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: 'https://115.com/web/lixian/?ct=lixian&ac=add_task_url',
                    anonymous: false,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    data: body,
                    onload: (r2) => {
                        let d
                        try {
                            d = JSON.parse(r2.responseText)
                        } catch (e) {
                            return fail('115 返回异常：' + r2.responseText.slice(0, 100), true)
                        }
                        if (d.state) {
                            btn.textContent = '✓ 已提交'
                            btn.style.backgroundColor = 'lightgreen'
                            show115Notice('已通过当前 ' + runtime.name + ' 的登录状态提交到 115。\n请到 115 网盘「离线下载」查看任务。', 'success', 8000)
                        } else {
                            fail(d.error_msg || d.error || ('被拒绝：' + JSON.stringify(d).slice(0, 120)), true)
                        }
                    },
                    onerror: () => fail('提交请求失败（网络或跨域被拦截）', true)
                })
            },
            onerror: () => fail('连接 115 失败（网络或跨域被拦截）', true)
        })
    }

    // ==================== 115 网盘番号查找 ====================
    // 只查询当前浏览器可用的 115 登录态，不会自动转存或下载。
    function get115SearchKeywords(code) {
        const value = String(code || '')
        const numberPair = value.match(/^(\d{4,8})[-_ ](\d{2,5})(?:$|[^A-Za-z0-9])/)
        if (numberPair) {
            return {
                exact: numberPair[1] + '-' + numberPair[2],
                fallback: numberPair[1] + ' ' + numberPair[2],
                display: numberPair[1] + '-' + numberPair[2]
            }
        }
        const match = value.match(/^([A-Za-z]{2,8})[-_ ]?(\d{1,8})/)
        if (!match) {
            const numberOnly = value.match(/^(\d{2,8})/)
            if (!numberOnly) return { exact: '', fallback: '', display: '' }
            return { exact: numberOnly[1], fallback: numberOnly[1], display: numberOnly[1] }
        }
        const prefix = match[1].toUpperCase()
        const digits = match[2]
        return {
            exact: prefix + '-' + digits,
            fallback: prefix + ' ' + digits,
            display: prefix + '-' + digits
        }
    }

    function is115LoginFailure(response, data) {
        const status = Number(response && response.status) || 0
        if (status === 401 || status === 403) return true
        const text = JSON.stringify(data || {})
        return /未登录|登录已过期|请先登录|login|auth|990001/i.test(text)
    }

    function request115CloudSearch(keyword) {
        const params = new URLSearchParams({
            search_value: keyword,
            format: 'json',
            aid: '1',
            cid: '0',
            offset: '0',
            limit: '100',
            type: '0'
        })
        const url = 'https://webapi.115.com/files/search?' + params.toString()
        return request115JsonWithPageFallback('GET', url, undefined, 15000).then(data => {
            const payload = data && data.data
            return Array.isArray(payload)
                ? payload
                : Array.isArray(payload && payload.list)
                    ? payload.list
                    : Array.isArray(data && data.list)
                        ? data.list
                        : []
        })
    }

    function get115PageFetch() {
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow && typeof unsafeWindow.fetch === 'function') return unsafeWindow.fetch.bind(unsafeWindow)
        } catch (error) {}
        try {
            if (typeof window !== 'undefined' && typeof window.fetch === 'function') return window.fetch.bind(window)
        } catch (error) {}
        return null
    }

    function request115JsonFromPage(method, url, data, timeout) {
        return new Promise((resolve, reject) => {
            const pageFetch = get115PageFetch()
            if (!pageFetch) {
                reject({ type: 'network', status: 0, message: '当前页面没有可用的 115 fetch 会话' })
                return
            }
            const controller = typeof AbortController === 'function' ? new AbortController() : null
            const timer = setTimeout(() => controller && controller.abort(), timeout || 20000)
            const options = {
                method: method || 'GET',
                credentials: 'include',
                headers: { Accept: 'application/json' }
            }
            if (controller) options.signal = controller.signal
            if (data !== undefined && data !== null) {
                options.body = data
                options.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
            }
            pageFetch(url, options).then(async response => {
                const text = await response.text()
                let payload
                try { payload = JSON.parse(text || '{}') } catch (error) {
                    throw {
                        type: 'server', status: Number(response.status) || 0,
                        message: '115 返回的不是有效 JSON（HTTP ' + response.status + '）',
                        responseText: String(text || '').slice(0, 180)
                    }
                }
                if (is115LoginFailure(response, payload)) {
                    throw { type: 'auth', message: '当前 115 网页没有可用的登录状态' }
                }
                if (Number(response.status) >= 400 || payload.state === false || payload.state === 0) {
                    throw {
                        type: 'server', status: Number(response.status) || 0,
                        message: payload.error_msg || payload.error || payload.message || payload.msg || ('115 请求失败（HTTP ' + response.status + '）'),
                        response: payload
                    }
                }
                return payload
            }).then(resolve).catch(error => {
                if (error && error.name === 'AbortError') {
                    reject({ type: 'network', status: 0, message: '115 网页请求超时' })
                    return
                }
                reject(error && error.type ? error : { type: 'network', status: 0, message: '115 网页请求失败（登录态或跨域被拦截）', cause: error })
            }).finally(() => clearTimeout(timer))
        })
    }

    function request115Json(method, url, data, timeout) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject({ type: 'unsupported', message: '脚本没有 GM_xmlhttpRequest 权限' })
                return
            }
            const options = {
                method: method || 'GET',
                url: url,
                anonymous: false,
                withCredentials: true,
                timeout: timeout || 20000,
                headers: { Accept: 'application/json', Referer: 'https://115.com/' },
                onload: response => {
                    let payload
                    try {
                        payload = JSON.parse(response.responseText || '{}')
                    } catch (error) {
                        reject({
                            type: 'server',
                            status: Number(response.status) || 0,
                            message: '115 返回的不是有效 JSON（HTTP ' + response.status + '）',
                            responseText: String(response.responseText || '').slice(0, 180)
                        })
                        return
                    }
                    if (is115LoginFailure(response, payload)) {
                        reject({ type: 'auth', message: '当前浏览器没有可用的 115 登录状态' })
                        return
                    }
                    if (Number(response.status) >= 400 || payload.state === false || payload.state === 0) {
                        reject({
                            type: 'server',
                            status: Number(response.status) || 0,
                            message: payload.error_msg || payload.error || payload.message || payload.msg || ('115 请求失败（HTTP ' + response.status + '）'),
                            response: payload
                        })
                        return
                    }
                    resolve(payload)
                },
                ontimeout: () => reject({ type: 'network', status: 0, message: '115 请求超时' }),
                onerror: () => reject({ type: 'network', status: 0, message: '115 请求失败（网络或跨域被拦截）' })
            }
            if (data !== undefined && data !== null) {
                options.data = data
                options.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
            }
            GM_xmlhttpRequest(options)
        })
    }

    async function request115JsonWithPageFallback(method, url, data, timeout) {
        const isWebApi = /^https:\/\/webapi\.115\.com\//i.test(String(url || ''))
        const is115Page = /(?:^|\.)115\.com$/i.test(String(location.hostname || ''))
        if (isWebApi && is115Page) {
            try {
                return await request115JsonFromPage(method, url, data, timeout)
            } catch (error) {
                if (error && (error.type === 'auth' || error.type === 'server')) throw error
            }
        }
        return request115Json(method, url, data, timeout)
    }

    async function request115JsonWithRetry(method, url, data, timeout, attempts) {
        const maxAttempts = Math.max(1, Number(attempts) || 1)
        let lastError = null
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                return await request115JsonWithPageFallback(method, url, data, timeout)
            } catch (error) {
                lastError = error
                if (error && error.type === 'auth') throw error
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 500 * attempt))
                }
            }
        }
        throw lastError || new Error('115请求失败')
    }

    let localSyncParentRenameQueue = Promise.resolve()
    let localSyncParentRenamePollTimer = null
    let localSyncParentRenamePollBusy = false
    let localSyncParentRenamePollCid = ''
    let localSyncParentRenameSnapshot = new Map()
    const LOCAL_SYNC_PARENT_RENAME_POLL_INTERVAL = 2500

    function is115BatchRenameUrl(url) {
        return /\/files\/batch_rename(?:[?#]|$)/i.test(String(url || ''))
    }

    function parse115BatchRenameBody(body) {
        if (!body) return []
        let pairs = []
        try {
            if (typeof body === 'string') {
                pairs = Array.from(new URLSearchParams(body).entries())
            } else if (typeof body.entries === 'function') {
                pairs = Array.from(body.entries())
            }
        } catch (error) { return [] }
        return pairs.map(pair => {
            const key = String(pair[0] || '')
            const match = key.match(/^files_new_name\[([^\]]+)\]$/i)
            return match ? { fileId: String(match[1]), name: String(pair[1] || '').trim() } : null
        }).filter(item => item && item.fileId && item.name)
    }

    function get115CurrentFolderCid() {
        const match = String(location.href || '').match(/[?&#]cid=(\d+)/i)
        return match ? String(match[1]) : ''
    }

    function remove115VideoExtension(name) {
        return String(name || '').trim().replace(/\.(?:mp4|m4v|mkv|wmv|avi|mov|flv|ts|m2ts|webm|mpeg|mpg|3gp|rmvb|vob)$/i, '').trim()
    }

    async function find115ParentForRenamedVideo(entry) {
        const candidateCids = []
        try {
            const rawItems = await request115CloudSearch(entry.name)
            rawItems.map(normalize115File).forEach(item => {
                const sameId = entry.fileId && item.fileId && String(item.fileId) === String(entry.fileId)
                const sameName = get115FileNameKey(item.name) === get115FileNameKey(entry.name)
                if (!item.isFolder && item.parentCid && (sameId || sameName)) candidateCids.push(String(item.parentCid))
            })
        } catch (error) {}
        const currentCid = get115CurrentFolderCid()
        if (currentCid) candidateCids.push(currentCid)
        const uniqueCids = Array.from(new Set(candidateCids.filter(cid => /^\d+$/.test(cid) && cid !== '0')))
        for (const parentCid of uniqueCids) {
            try {
                const children = await request115FolderChildren(parentCid)
                const file = children.find(item => {
                    if (item.isFolder) return false
                    const sameId = entry.fileId && item.fileId && String(item.fileId) === String(entry.fileId)
                    const sameName = get115FileNameKey(item.name) === get115FileNameKey(entry.name)
                    return sameId || sameName
                })
                if (file) return { parentCid: parentCid, parentName: file.parentName || '' }
            } catch (error) {}
        }
        return null
    }

    async function sync115ParentFolderNameFromVideoRename(entry) {
        if (!getLocalSyncBooleanSetting(LOCAL_SYNC_PARENT_RENAME_SYNC_KEY, false)) return
        if (!entry || !LOCAL_SYNC_VIDEO_EXTENSIONS.test(entry.name)) return
        const parentName = remove115VideoExtension(entry.name)
        if (!parentName) return
        const parent = entry.parentCid
            ? entry
            : await find115ParentForRenamedVideo(entry)
        if (!parent || !parent.parentCid || parent.parentCid === '0') {
            throw new Error('无法确认视频所在的上级目录，已跳过自动改名')
        }
        const currentName = String(parent.parentName || '').split(/[\\/]/).filter(Boolean).pop() || ''
        if (currentName && get115FileNameKey(currentName) === get115FileNameKey(parentName)) return
        const body = new URLSearchParams([[ 'files_new_name[' + String(parent.parentCid) + ']', parentName ]]).toString()
        await request115JsonWithPageFallback('POST', 'https://webapi.115.com/files/batch_rename', body)
        show115Notice('已同步：上级目录已改为“' + parentName + '”。', 'success', 6000)
    }

    async function poll115CurrentFolderVideoRenames() {
        if (!getLocalSyncBooleanSetting(LOCAL_SYNC_PARENT_RENAME_SYNC_KEY, false)) {
            localSyncParentRenamePollCid = ''
            localSyncParentRenameSnapshot = new Map()
            return
        }
        const parentCid = get115CurrentFolderCid()
        if (!parentCid || parentCid === '0' || localSyncParentRenamePollBusy) return
        localSyncParentRenamePollBusy = true
        try {
            const items = await request115FolderChildren(parentCid)
            const nextSnapshot = new Map()
            items.filter(item => !item.isFolder && item.isVideo && item.fileId).forEach(item => {
                nextSnapshot.set(String(item.fileId), {
                    name: item.name,
                    parentName: item.parentName || '',
                    parentCid: parentCid
                })
            })
            if (localSyncParentRenamePollCid !== parentCid) {
                localSyncParentRenamePollCid = parentCid
                localSyncParentRenameSnapshot = nextSnapshot
                return
            }
            nextSnapshot.forEach((current, fileId) => {
                const previous = localSyncParentRenameSnapshot.get(fileId)
                if (!previous || get115FileNameKey(previous.name) === get115FileNameKey(current.name)) return
                if (!LOCAL_SYNC_VIDEO_EXTENSIONS.test(current.name)) return
                schedule115ParentFolderRename(Object.assign({ fileId: fileId }, current))
            })
            localSyncParentRenameSnapshot = nextSnapshot
        } catch (error) {
            // 网络暂时异常时保留上一轮快照，下一轮继续检测。
        } finally {
            localSyncParentRenamePollBusy = false
        }
    }

    function schedule115ParentFolderRename(entry) {
        localSyncParentRenameQueue = localSyncParentRenameQueue
            .then(() => sync115ParentFolderNameFromVideoRename(entry))
            .catch(error => {
                show115Notice('视频已改名，但上级目录同步失败：' + (error && error.message || error || '未知错误'), 'warning', 8000)
            })
    }

    function install115ParentRenameSync() {
        if (!is115UserPage() || typeof unsafeWindow === 'undefined') return
        const pageWindow = unsafeWindow
        if (pageWindow.__missav115ParentRenameHookInstalled) return
        pageWindow.__missav115ParentRenameHookInstalled = true
        try {
            const nativeFetch = pageWindow.fetch
            if (typeof nativeFetch === 'function') {
                pageWindow.fetch = function(input, init) {
                    const url = typeof input === 'string' ? input : input && input.url
                    const body = init && init.body !== undefined ? init.body : input && input.body
                    const result = nativeFetch.apply(this, arguments)
                    if (is115BatchRenameUrl(url)) {
                        Promise.resolve(result).then(response => {
                            if (!response || !response.ok) return
                            parse115BatchRenameBody(body).filter(item => LOCAL_SYNC_VIDEO_EXTENSIONS.test(item.name)).forEach(schedule115ParentFolderRename)
                        }).catch(() => {})
                    }
                    return result
                }
            }
            const xhrPrototype = pageWindow.XMLHttpRequest && pageWindow.XMLHttpRequest.prototype
            if (xhrPrototype && !xhrPrototype.__missav115ParentRenameHookInstalled) {
                const nativeOpen = xhrPrototype.open
                const nativeSend = xhrPrototype.send
                const metadata = new WeakMap()
                xhrPrototype.open = function(method, url) {
                    metadata.set(this, { url: String(url || '') })
                    return nativeOpen.apply(this, arguments)
                }
                xhrPrototype.send = function(body) {
                    const info = metadata.get(this)
                    if (info && is115BatchRenameUrl(info.url)) {
                        this.addEventListener('load', () => {
                            if (Number(this.status) >= 200 && Number(this.status) < 300) {
                                parse115BatchRenameBody(body).filter(item => LOCAL_SYNC_VIDEO_EXTENSIONS.test(item.name)).forEach(schedule115ParentFolderRename)
                            }
                        }, { once: true })
                    }
                    return nativeSend.apply(this, arguments)
                }
                xhrPrototype.__missav115ParentRenameHookInstalled = true
            }
            if (!localSyncParentRenamePollTimer) {
                poll115CurrentFolderVideoRenames()
                localSyncParentRenamePollTimer = setInterval(poll115CurrentFolderVideoRenames, LOCAL_SYNC_PARENT_RENAME_POLL_INTERVAL)
                pageWindow.addEventListener('popstate', () => {
                    localSyncParentRenamePollCid = ''
                    localSyncParentRenameSnapshot = new Map()
                })
                pageWindow.addEventListener('hashchange', () => {
                    localSyncParentRenamePollCid = ''
                    localSyncParentRenameSnapshot = new Map()
                })
            }
        } catch (error) {
            console.warn('[MissAV 115] 无法安装视频改名同步监听：', error)
        }
    }

    function get115ListFromPayload(payload) {
        const data = payload && payload.data
        return Array.isArray(data)
            ? data
            : Array.isArray(data && data.list)
                ? data.list
                : Array.isArray(data && data.data)
                    ? data.data
                : Array.isArray(payload && payload.list)
                    ? payload.list
                    : []
    }

    function get115FolderCidFromPayload(payload) {
        const candidates = []
        const add = value => {
            if (value === undefined || value === null) return
            const text = String(value).trim()
            if (text) candidates.push(text)
        }
        const addObject = value => {
            if (!value || typeof value !== 'object') return
            ;['cid', 'file_id', 'cate_id', 'folder_id', 'category_id'].forEach(key => add(value[key]))
        }
        addObject(payload)
        const data = payload && payload.data
        addObject(data)
        if (Array.isArray(data)) data.forEach(addObject)
        else if (data && Array.isArray(data.data)) data.data.forEach(addObject)
        const cid = candidates.find(value => /^\d+$/.test(value))
        return cid || ''
    }

    function is115FolderItem(item) {
        if (!item || typeof item !== 'object') return false
        const fileType = item.file_type ?? item.fileType ?? item.kind
        const dirFlag = item.is_dir ?? item.is_folder ?? item.is_directory
        if (dirFlag === true || String(dirFlag) === '1') return true
        if (['0', 'folder', 'dir', 'directory'].includes(String(fileType ?? '').toLowerCase())) return true
        // 115旧网页接口用 {cid, n} 表示目录、用 {fid, n} 表示文件。
        const folderId = item.cid ?? item.category_id ?? item.cate_id ?? item.folder_id
        const fileId = item.file_id ?? item.fid ?? item.fileId
        return folderId !== undefined && folderId !== null && String(folderId).trim() !== '' &&
            (fileId === undefined || fileId === null || String(fileId).trim() === '')
    }

    function normalize115File(item) {
        const name = String(item && (item.file_name || item.name || item.n || item.fileName) || '').trim()
        const pickCode = String(item && (item.pick_code || item.pickcode || item.pc) || '').trim()
        const sizeValue = item && (item.file_size ?? item.size ?? item.fsize ?? item.s ?? item.fileSize ?? item.size_bytes)
        const sizeBytes = parse115SizeBytes(sizeValue)
        const path = String(item && (item.parent_name || item.path || item.parent_path) || '').trim()
        const parentName = String(item && (item.parent_name || item.parentName) || '').trim()
        const isFolder = is115FolderItem(item)
        const mime = String(item && (item.mime_type || item.mime || item.content_type || item.category) || '').toLowerCase()
        const lowerName = name.toLowerCase()
        const isImage = /\.(?:jpe?g|png|gif|webp|bmp|svg|avif|heic|tiff?)(?:$|[?#])/i.test(lowerName) ||
            /image|photo|picture/.test(mime)
        const isVideo = !isFolder && !isImage && (
            /\.(?:mp4|m4v|mkv|avi|mov|wmv|flv|ts|m2ts|webm|mpeg|mpg|3gp|rmvb|vob)(?:$|[?#])/i.test(lowerName) ||
            /video|movie|hls/.test(mime) ||
            String(item && (item.iv ?? item.is_video ?? item.isVideo) || '') === '1' ||
            item && (item.is_video === true || item.isVideo === true)
        )
        const parentValue = item && (item.parent_cid ?? item.parent_id ?? item.pid ?? item.cid)
        const parentCid = parentValue === undefined || parentValue === null ? '' : String(parentValue).trim()
        const folderValue = item && (item.cid ?? item.file_id ?? item.fid ?? item.id)
        const folderCid = isFolder && folderValue !== undefined && folderValue !== null
            ? String(folderValue).trim()
            : ''
        const fileValue = item && (item.file_id ?? item.fid ?? item.id)
        const fileId = fileValue === undefined || fileValue === null ? '' : String(fileValue).trim()
        return { name: name || '未命名文件', pickCode, sizeBytes, path, parentName, parentCid, folderCid, fileId, isFolder, isImage, isVideo }
    }

    function parse115SizeBytes(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value
        const text = String(value ?? '').trim().replace(/,/g, '')
        if (!text) return 0
        const plain = Number(text)
        if (Number.isFinite(plain)) return plain
        const match = text.match(/^(\d+(?:\.\d+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB|TB|TIB)$/i)
        if (!match) return 0
        const units = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 }
        return Number(match[1]) * Math.pow(1024, units[match[2].toUpperCase()] || 0)
    }

    function format115FileSize(bytes) {
        const value = Number(bytes) || 0
        if (!value) return '容量未知'
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        let index = 0
        let current = value
        while (current >= 1024 && index < units.length - 1) {
            current /= 1024
            index += 1
        }
        return current.toFixed(index ? (current >= 10 ? 1 : 2) : 0) + ' ' + units[index]
    }

    function get115FileNameKey(name) {
        let text = String(name || '').trim()
        try {
            text = text.normalize('NFKC')
        } catch (error) {
            // 某些旧浏览器没有 String.prototype.normalize，使用原始文件名即可。
        }
        return text.replace(/\s+/g, ' ').toUpperCase()
    }

    function prefer115File(current, candidate) {
        if (!current) return candidate
        const currentPlayable = Boolean(current.pickCode)
        const candidatePlayable = Boolean(candidate.pickCode)
        if (currentPlayable !== candidatePlayable) {
            return candidatePlayable ? candidate : current
        }
        const currentSize = Number(current.sizeBytes) || 0
        const candidateSize = Number(candidate.sizeBytes) || 0
        if (candidateSize > currentSize) return candidate
        return current
    }

    function filter115VideoResults(items, keyword) {
        const match = String(keyword || '').match(/^([A-Z]{2,8})[-_ ]?(\d{1,8})$/i)
        const prefix = match ? match[1].toUpperCase() : ''
        const number = match ? String(Number(match[2])) : ''
        const exactPattern = prefix && number
            ? new RegExp(prefix + '[^A-Z0-9]{0,5}0*' + number + '(?!\\d)', 'i')
            : null
        const normalized = (Array.isArray(items) ? items : [])
            .map(normalize115File)
            .filter(item => item.name && item.isVideo)
        const exact = exactPattern ? normalized.filter(item => exactPattern.test(item.name)) : []
        const selected = exactPattern ? exact : normalized
        // 115 搜索接口偶尔会把同一个文件返回两次：一条有 pick_code，另一条没有。
        // 不能用 pick_code 作为唯一键，否则无效记录会和可播放记录同时显示。
        const unique = new Map()
        selected.forEach(item => {
            const key = get115FileNameKey(item.name)
            unique.set(key, prefer115File(unique.get(key), item))
        })
        // 没有 pick_code 的记录无法拼出 115vod 播放地址，不再展示为可播放卡片。
        return Array.from(unique.values())
            .filter(item => item.pickCode)
            .slice(0, 20)
    }

    function search115CloudByPriority(keys, onFallback) {
        return request115CloudSearch(keys.exact).then(rawItems => {
            const exactItems = filter115VideoResults(rawItems, keys.exact)
            if (exactItems.length || !keys.fallback || keys.fallback === keys.exact) {
                return { items: exactItems, keyword: keys.exact }
            }
            if (typeof onFallback === 'function') onFallback()
            return request115CloudSearch(keys.fallback).then(fallbackItems => ({
                items: filter115VideoResults(fallbackItems, keys.fallback),
                keyword: keys.fallback
            }))
        })
    }

    function open115VideoFile(item, keyword) {
        if (!item || !item.pickCode) {
            show115Notice('该文件没有可用的 115 播放标识，无法打开播放页。', 'warning', 7000)
            return
        }
        const target = 'https://115vod.com/?pickcode=' + encodeURIComponent(item.pickCode) + '&share_id=0'
        if (typeof GM_openInTab === 'function') {
            GM_openInTab(target, { active: true, insert: true })
            return
        }
        const tab = window.open(target, '_blank', 'noopener')
        if (!tab) show115Notice('浏览器阻止了 115 播放页，请允许打开新标签页后重试。', 'warning', 7000)
    }

    function open115ParentFolder(item, keyword) {
        const target = item && item.parentCid
            ? 'https://115.com/?cid=' + encodeURIComponent(item.parentCid) + '&offset=0&mode=wangpan'
            : 'https://115.com/?ct=search&search_value=' + encodeURIComponent(keyword || (item && item.name) || '')
        if (typeof GM_openInTab === 'function') {
            GM_openInTab(target, { active: true, insert: true })
            return
        }
        const tab = window.open(target, '_blank', 'noopener')
        if (!tab) show115Notice('浏览器阻止了 115 文件夹页面，请允许打开新标签页后重试。', 'warning', 7000)
    }

    // ==================== 115 本地媒体/字幕同步 ====================
    // 浏览器安全模型不允许脚本静默遍历任意本地目录，因此这里使用用户主动授权的目录句柄。
    const LOCAL_SYNC_DB = 'missav-115-local-sync-v1'
    const LOCAL_SYNC_STORE = 'state'
    const LOCAL_SYNC_HANDLE_KEY = 'directory-handle'
    const LOCAL_SYNC_HANDLES_KEY = 'directory-handles'
    const LOCAL_SYNC_CHANNEL = 'missav-115-local-sync-v1'
    const LOCAL_SYNC_VIDEO_EXTENSIONS = /\.(mp4|m4v|mkv|wmv|avi|mov|flv|ts|m2ts|webm|mpeg|mpg|3gp|rmvb|vob)$/i
    const LOCAL_SYNC_SUBTITLE_EXTENSIONS = /\.(srt|ass|ssa|vtt|sup)$/i
    const LOCAL_SYNC_CODE_RE = /(^|[^A-Za-z0-9])([A-Za-z]{2,10})[-_ ]?(\d{2,8})(?=[^A-Za-z0-9]|$)/i
    const LOCAL_SYNC_NUMBER_PAIR_RE = /(^|[^A-Za-z0-9])(\d{4,8})[-_ ](\d{2,5})(?=[^A-Za-z0-9]|$)/
    const LOCAL_SYNC_NUMBER_RE = /(^|[^A-Za-z0-9])(\d{2,8})(?=[^A-Za-z0-9]|$)/i
    const LOCAL_SYNC_TARGET_CID_KEY = 'missav-115-local-sync-target-cid'
    const LOCAL_SYNC_HIDE_EXISTING_KEY = 'missav-115-local-sync-hide-existing'
    const LOCAL_SYNC_EXCLUDED_KEY = 'missav-115-local-sync-excluded'
    const LOCAL_SYNC_PARENT_RENAME_SYNC_KEY = 'missav-115-local-sync-parent-rename'
    const LOCAL_SYNC_TOGGLE_TOP_KEY = 'missav-115-local-sync-toggle-top'
    const LOCAL_SYNC_TOGGLE_LEFT_KEY = 'missav-115-local-sync-toggle-left'
    const LOCAL_SYNC_CARD_TOP_KEY = 'missav-115-local-sync-card-top'
    const LOCAL_SYNC_CARD_LEFT_KEY = 'missav-115-local-sync-card-left'
    let localSyncState = null
    let localSyncChannel = null
    let localSyncEnsureObserver = null
    let localSyncEnsureTimer = null
    let localSyncEnsureInterval = null

    function is115UserPage() {
        return /^(?:www\.)?115\.com$/i.test(location.hostname)
    }

    function openLocalSyncDb() {
        return new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('当前浏览器不支持 IndexedDB，无法记住本地目录授权'))
                return
            }
            const request = indexedDB.open(LOCAL_SYNC_DB, 1)
            request.onupgradeneeded = () => {
                const db = request.result
                if (!db.objectStoreNames.contains(LOCAL_SYNC_STORE)) db.createObjectStore(LOCAL_SYNC_STORE)
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error || new Error('无法打开本地同步设置'))
        })
    }

    function saveLocalSyncDirectoryHandles(entries) {
        return openLocalSyncDb().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(LOCAL_SYNC_STORE, 'readwrite')
            const handles = (Array.isArray(entries) ? entries : [])
                .map(entry => entry && entry.handle ? entry.handle : entry)
                .filter(Boolean)
            tx.objectStore(LOCAL_SYNC_STORE).put(handles, LOCAL_SYNC_HANDLES_KEY)
            tx.oncomplete = () => { db.close(); resolve() }
            tx.onerror = () => { const error = tx.error || new Error('无法保存本地目录授权'); db.close(); reject(error) }
        }))
    }

    function loadLocalSyncDirectoryHandles() {
        return openLocalSyncDb().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(LOCAL_SYNC_STORE, 'readonly')
            const store = tx.objectStore(LOCAL_SYNC_STORE)
            const request = store.get(LOCAL_SYNC_HANDLES_KEY)
            request.onsuccess = () => {
                if (Array.isArray(request.result) && request.result.length) {
                    resolve(request.result.filter(Boolean))
                    return
                }
                const legacyRequest = store.get(LOCAL_SYNC_HANDLE_KEY)
                legacyRequest.onsuccess = () => resolve(legacyRequest.result ? [legacyRequest.result] : [])
                legacyRequest.onerror = () => reject(legacyRequest.error || new Error('无法读取本地目录授权'))
            }
            request.onerror = () => reject(request.error || new Error('无法读取本地目录授权'))
            tx.oncomplete = () => db.close()
            tx.onerror = () => { db.close(); reject(tx.error || new Error('无法读取本地目录授权')) }
        }))
    }

    async function chooseLocalSyncDirectory() {
        if (typeof window.showDirectoryPicker !== 'function') {
            throw new Error('当前浏览器不支持本地目录授权，请使用支持 File System Access API 的 Chrome/115 浏览器')
        }
        const handle = await window.showDirectoryPicker({ mode: 'read' })
        if (!handle) throw new Error('没有选择本地目录')
        const permission = handle.requestPermission
            ? await handle.requestPermission({ mode: 'read' })
            : 'granted'
        if (permission !== 'granted') throw new Error('没有获得本地目录读取权限')
        return handle
    }

    async function hasLocalSyncPermission(handle, requestPermission) {
        if (!handle) return false
        if (typeof handle.queryPermission === 'function' && await handle.queryPermission({ mode: 'read' }) === 'granted') return true
        if (!requestPermission || typeof handle.requestPermission !== 'function') return false
        return await handle.requestPermission({ mode: 'read' }) === 'granted'
    }

    function normalizeLocalSyncCode(prefix, digits) {
        return String(prefix || '').toUpperCase() + '-' + String(digits || '')
    }

    function extractLocalSyncCodeFromName(name) {
        const text = String(name || '')
        const match = text.match(LOCAL_SYNC_CODE_RE)
        if (match) return normalizeLocalSyncCode(match[2], match[3])
        const numberPair = text.match(LOCAL_SYNC_NUMBER_PAIR_RE)
        if (numberPair) return numberPair[2] + '-' + numberPair[3]
        const numberOnly = text.match(LOCAL_SYNC_NUMBER_RE)
        return numberOnly ? numberOnly[2] : ''
    }

    function extractLocalSyncFile(file, fileHandle, relativePath) {
        const name = String(file && file.name || '').trim()
        if (!name || (!LOCAL_SYNC_VIDEO_EXTENSIONS.test(name) && !LOCAL_SYNC_SUBTITLE_EXTENSIONS.test(name))) return null
        const code = extractLocalSyncCodeFromName(name)
        if (!code) return null
        return {
            id: String(relativePath || name) + '|' + name + '|' + String(file.lastModified || 0) + '|' + String(file.size || 0),
            file: file,
            fileHandle: fileHandle,
            name: name,
            relativePath: relativePath || name,
            code: code,
            kind: LOCAL_SYNC_VIDEO_EXTENSIONS.test(name) ? 'video' : 'subtitle',
            size: Number(file.size) || 0,
            lastModified: Number(file.lastModified) || 0
        }
    }

    async function scanLocalSyncDirectory(handle) {
        if (!handle || typeof handle.entries !== 'function') throw new Error('本地目录句柄不可用，请重新选择目录')
        const records = []
        const visit = async (directory, prefix) => {
            for await (const [name, entry] of directory.entries()) {
                const relativePath = prefix ? prefix + '/' + name : name
                if (entry.kind === 'directory') {
                    await visit(entry, relativePath)
                    continue
                }
                if (entry.kind !== 'file' || !entry.getFile) continue
                const record = extractLocalSyncFile(await entry.getFile(), entry, relativePath)
                if (record) records.push(record)
            }
        }
        await visit(handle, '')
        records.sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name))
        return records
    }

    async function scanLocalSyncDirectories(entries) {
        const directories = Array.isArray(entries) ? entries : []
        const allRecords = []
        for (let index = 0; index < directories.length; index += 1) {
            const entry = directories[index]
            const handle = entry && entry.handle ? entry.handle : entry
            const directoryName = String(entry && entry.name || handle && handle.name || '本地目录').trim() || '本地目录'
            if (!await hasLocalSyncPermission(handle, true)) throw new Error('目录“' + directoryName + '”未获得读取权限')
            const records = await scanLocalSyncDirectory(handle)
            records.forEach(record => {
                record.sourceIndex = index
                record.sourceName = directoryName
                record.sourceNames = [directoryName]
                allRecords.push(record)
            })
        }
        const byName = new Map()
        allRecords.forEach(record => {
            const key = get115FileNameKey(record.name)
            if (!byName.has(key)) byName.set(key, [])
            byName.get(key).push(record)
        })
        byName.forEach(group => {
            const highestPriorityIndex = Math.min(...group.map(record => Number(record.sourceIndex) || 0))
            const sourceNames = Array.from(new Set(group.map(record => record.sourceName).filter(Boolean)))
            group.forEach(record => {
                record.sourceNames = sourceNames
                record.isPriorityDuplicate = group.length > 1 && record.sourceIndex === highestPriorityIndex
                record.preferSubtitle = record.kind === 'subtitle' && record.isPriorityDuplicate
            })
        })
        return allRecords.sort((a, b) => a.code.localeCompare(b.code)
            || a.name.localeCompare(b.name)
            || (Number(a.sourceIndex) || 0) - (Number(b.sourceIndex) || 0)
            || String(a.relativePath || '').localeCompare(String(b.relativePath || '')))
    }

    function getLocalSyncTargetCid() {
        try {
            const value = typeof GM_getValue === 'function'
                ? GM_getValue(LOCAL_SYNC_TARGET_CID_KEY, '')
                : localStorage.getItem(LOCAL_SYNC_TARGET_CID_KEY) || ''
            const cid = String(value || '').trim()
            return /^\d+$/.test(cid) && cid !== '0' ? cid : ''
        } catch (error) { return '' }
    }

    function saveLocalSyncTargetCid(value) {
        const cid = String(value || '').trim()
        if (!/^\d+$/.test(cid) || cid === '0') return false
        try {
            if (typeof GM_setValue === 'function') GM_setValue(LOCAL_SYNC_TARGET_CID_KEY, cid)
            else localStorage.setItem(LOCAL_SYNC_TARGET_CID_KEY, cid)
            return true
        } catch (error) { return false }
    }

    function readLocalSyncSetting(key, fallback) {
        try {
            const value = typeof GM_getValue === 'function'
                ? GM_getValue(key, fallback)
                : localStorage.getItem(key)
            return value === null || value === undefined ? fallback : value
        } catch (error) { return fallback }
    }

    function writeLocalSyncSetting(key, value) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(key, value)
            else localStorage.setItem(key, String(value))
            return true
        } catch (error) { return false }
    }

    function getLocalSyncBooleanSetting(key, fallback) {
        const value = readLocalSyncSetting(key, fallback)
        if (typeof value === 'boolean') return value
        return /^(?:1|true|yes)$/i.test(String(value || ''))
    }

    function getLocalSyncRecordKey(record) {
        if (!record) return ''
        return [record.sourceName || '', record.relativePath || record.name || '', record.name || '']
            .map(value => get115FileNameKey(value))
            .join('|')
    }

    function loadLocalSyncExclusions() {
        let value = readLocalSyncSetting(LOCAL_SYNC_EXCLUDED_KEY, {})
        if (typeof value === 'string') {
            try { value = JSON.parse(value) } catch (error) { value = {} }
        }
        const result = {}
        if (Array.isArray(value)) {
            value.forEach(entry => {
                if (entry && entry.key) result[String(entry.key)] = entry
            })
            return result
        }
        if (!value || typeof value !== 'object') return result
        Object.keys(value).forEach(key => {
            const entry = value[key]
            result[key] = entry && typeof entry === 'object'
                ? Object.assign({ key: key }, entry)
                : { key: key, name: String(entry || '') }
        })
        return result
    }

    function saveLocalSyncExclusions(exclusions) {
        return writeLocalSyncSetting(LOCAL_SYNC_EXCLUDED_KEY, JSON.stringify(exclusions || {}))
    }

    async function query115LocalSyncRemoteFiles(code) {
        const keys = get115SearchKeywords(code)
        if (!keys.exact) return []
        const exact = await request115CloudSearch(keys.exact)
        if (exact.length || !keys.fallback || keys.fallback === keys.exact) return exact.map(normalize115File)
        return (await request115CloudSearch(keys.fallback)).map(normalize115File)
    }

    function find115LocalSyncRemoteByName(items, name) {
        const key = get115FileNameKey(name)
        return (Array.isArray(items) ? items : []).find(item => !item.isFolder && get115FileNameKey(item.name) === key) || null
    }

    function prefer115LocalSyncRemote(current, candidate) {
        if (!current) return candidate
        if (!candidate) return current
        const currentSize = Number(current.sizeBytes) || 0
        const candidateSize = Number(candidate.sizeBytes) || 0
        return candidateSize > currentSize ? candidate : current
    }

    function find115LocalSyncRemoteByRecord(items, record) {
        const list = (Array.isArray(items) ? items : []).filter(item => item && !item.isFolder)
        const expectedKind = record && record.kind
        return list.find(item =>
            get115FileNameKey(item.name) === get115FileNameKey(record && record.name) &&
            (expectedKind === 'video' ? item.isVideo : !item.isVideo)
        ) || null
    }

    function getLocalSyncFolderName(records, code) {
        const names = (Array.isArray(records) ? records : [])
            .filter(record => record && record.kind === 'video')
            .map(record => String(record.name || '').replace(/\.[^.]+$/, '').trim())
            .filter(Boolean)
            .map(name => name.replace(/\s+[-_]?\s*\d{1,3}$/, '').trim())
            .filter(Boolean)
        names.sort((a, b) => a.length - b.length || a.localeCompare(b))
        return names[0] || String(code || '').trim()
    }

    function find115LocalSyncVideoFolder(items, records, code) {
        const remoteVideos = (Array.isArray(items) ? items : []).filter(item =>
            item && !item.isFolder && item.isVideo &&
            extractLocalSyncCodeFromName(item.name) === String(code || '') &&
            /^\d+$/.test(String(item.parentCid || '')) && String(item.parentCid) !== '0'
        )
        if (!remoteVideos.length) return ''
        const localVideos = (Array.isArray(records) ? records : []).filter(record => record && record.kind === 'video')
        const exact = remoteVideos.find(remote => localVideos.some(local =>
            get115FileNameKey(local.name) === get115FileNameKey(remote.name)
        ))
        if (exact) return String(exact.parentCid)
        const counts = new Map()
        remoteVideos.forEach(item => counts.set(String(item.parentCid), (counts.get(String(item.parentCid)) || 0) + 1))
        return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0]
    }

    async function find115LocalSyncMatches(records, onProgress) {
        const byCode = new Map()
        ;(records || []).forEach(record => {
            if (!byCode.has(record.code)) byCode.set(record.code, [])
            byCode.get(record.code).push(record)
        })
        const matches = []
        let completed = 0
        for (const [code, group] of byCode.entries()) {
            let remoteItems = []
            let remoteError = null
            try { remoteItems = await query115LocalSyncRemoteFiles(code) } catch (error) { remoteError = error }
            group.forEach(record => {
                const remote = find115LocalSyncRemoteByRecord(remoteItems, record)
                const replaceExisting = Boolean(record.preferSubtitle && remote)
                matches.push({
                    record: record,
                    remote: remote,
                    exists: Boolean(remote) && !replaceExisting,
                    replaceExisting: replaceExisting,
                    status: replaceExisting ? 'replace' : remote ? 'exists' : remoteError ? 'check-error' : 'pending',
                    error: remoteError ? (remoteError.message || '115 查询失败') : ''
                })
            })
            completed += 1
            if (typeof onProgress === 'function') onProgress(completed, byCode.size, code, remoteError)
        }
        return matches.sort((a, b) => a.record.code.localeCompare(b.record.code) || a.record.name.localeCompare(b.record.name))
    }

    async function request115FolderChildren(parentCid) {
        const params = new URLSearchParams({
            aid: '1', cid: String(parentCid || '0'), o: 'file_name', asc: '1', offset: '0', show_dir: '1',
            limit: '1150', format: 'json', natsort: '1', fc_mix: '0'
        })
        const payload = await request115JsonWithPageFallback('GET', 'https://webapi.115.com/files?' + params.toString())
        return get115ListFromPayload(payload).map(normalize115File)
    }

    async function find115FolderByName(parentCid, folderName) {
        const items = await request115FolderChildren(parentCid)
        return items.find(item => item.isFolder && get115FileNameKey(item.name) === get115FileNameKey(folderName)) || null
    }

    async function find115TopLevelCloudDownloadFolder(cid) {
        const rootItems = await request115FolderChildren('0')
        return rootItems.find(item => item && item.isFolder && String(item.folderCid) === String(cid) &&
            get115FileNameKey(item.name) === get115FileNameKey('云下载')) || null
    }

    function find115SubtitleFolderFromNormalizedResults(items, folderName) {
        const normalizeName = value => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase()
        const expectedName = normalizeName(folderName)
        const list = Array.isArray(items) ? items : []
        const direct = list.find(item => item && item.isFolder && item.folderCid && normalizeName(item.name) === expectedName)
        if (direct) return direct

        const code = String(folderName || '').trim().match(/^([A-Za-z]{2,10})[-_ ]?(\d{1,8})$/)
        if (!code) return null
        const prefix = code[1].toUpperCase()
        const number = String(Number(code[2]))
        const videoPattern = new RegExp('(?:^|[^A-Z0-9])' + prefix + '[-_ ]?0*' + number + '(?!\\d)', 'i')
        const video = list.find(item => item && !item.isFolder && item.isVideo &&
            /^\d+$/.test(String(item.parentCid || '')) && String(item.parentCid) !== '0' &&
            videoPattern.test(String(item.name || '')))
        return video
            ? { name: String(folderName || '').trim(), folderCid: String(video.parentCid), fromVideo: true }
            : null
    }

    async function ensure115LocalSyncFolder(parentCid, folderName) {
        if (!/^\d+$/.test(String(parentCid || '')) || String(parentCid) === '0') {
            throw new Error('禁止在115根目录创建番号文件夹，请选择“云下载”目录')
        }
        if (!await find115TopLevelCloudDownloadFolder(parentCid)) {
            throw new Error('只能在115根目录下的“云下载”文件夹中创建番号文件夹')
        }
        const existing = await find115FolderByName(parentCid, folderName)
        if (existing && existing.folderCid) return existing.folderCid
        const body = new URLSearchParams({ pid: String(parentCid || '0'), cname: folderName }).toString()
        try {
            const payload = await request115JsonWithPageFallback('POST', 'https://webapi.115.com/files/add', body)
            const cid = get115FolderCidFromPayload(payload)
            if (cid) return cid
        } catch (error) {
            const text = JSON.stringify(error && (error.response || error.message || error))
            if (!/已存在|20004|already/i.test(text)) throw error
        }
        const afterCreate = await find115FolderByName(parentCid, folderName)
        if (afterCreate && afterCreate.folderCid) return afterCreate.folderCid
        throw new Error('无法找到或创建 115 文件夹：' + folderName)
    }

    async function resolve115LocalSyncFolder(code, records, remoteItems, targetCid) {
        const existingVideoCid = find115LocalSyncVideoFolder(remoteItems, records, code)
        if (existingVideoCid) return existingVideoCid
        if (!/^\d+$/.test(String(targetCid || '')) || String(targetCid) === '0') {
            throw new Error('目标CID不能是115根目录；请选择“云下载”或其他已有目录')
        }

        const targetFolder = await find115TopLevelCloudDownloadFolder(targetCid)
        if (targetFolder) {
            const cloudItems = await request115FolderChildren(targetFolder.folderCid)
            const folderName = getLocalSyncFolderName(records, code)
            const sameNumberFolders = cloudItems.filter(item => item && item.isFolder &&
                extractLocalSyncCodeFromName(item.name) === String(code || '')
            )
            const existing = sameNumberFolders.find(item => get115FileNameKey(item.name) === get115FileNameKey(folderName))
            if (existing && existing.folderCid) return String(existing.folderCid)
            if (sameNumberFolders.length === 1 && sameNumberFolders[0].folderCid) return String(sameNumberFolders[0].folderCid)
            if (sameNumberFolders.length > 1) throw new Error('“云下载”下有多个同番号文件夹，请先在目标CID中选择正确的已有文件夹')
            return ensure115LocalSyncFolder(targetFolder.folderCid, folderName)
        }

        await request115FolderChildren(targetCid)
        return String(targetCid)
    }

    function get115UploadInitData(payload) {
        const data = payload && payload.data && !Array.isArray(payload.data) ? payload.data : payload
        if (!data) throw new Error('115 上传接口没有返回数据')
        // 115旧网页通道命中秒传时不会返回host/object，此时应直接等待目标目录出现文件。
        if (!data.host && (Number(data.status) === 2 || Number(data.statuscode) === 0)) {
            return Object.assign({}, data, { instant: true })
        }
        if (!data.host || !data.object || !data.policy || !data.accessid || !data.signature) {
            throw new Error(data.error_msg || data.error || data.message || '115 上传接口未返回完整的上传参数')
        }
        return data
    }

    async function init115LocalSyncUpload(file, folderCid) {
        const body = new URLSearchParams({
            userid: '', filename: file.name, filesize: String(file.size || 0), target: 'U_1_' + String(folderCid), path: ''
        }).toString()
        const payload = await request115JsonWithRetry('POST', 'https://uplb.115.com/3.0/sampleinitupload.php', body, 30000, 2)
        return get115UploadInitData(payload)
    }

    function uploadLocalSyncToOss(file, uploadInfo, onProgress) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('脚本没有 GM_xmlhttpRequest 权限，无法上传本地文件'))
                return
            }
            const form = new FormData()
            form.append('name', file.name)
            form.append('key', uploadInfo.object)
            form.append('policy', uploadInfo.policy)
            form.append('OSSAccessKeyId', uploadInfo.accessid)
            form.append('success_action_status', '200')
            form.append('callback', uploadInfo.callback || '')
            form.append('signature', uploadInfo.signature)
            form.append('file', file, file.name)
            GM_xmlhttpRequest({
                method: 'POST', url: uploadInfo.host, data: form, anonymous: true, timeout: 1800000,
                onprogress: event => { if (typeof onProgress === 'function') onProgress(event) },
                onload: response => {
                    if (Number(response.status) < 200 || Number(response.status) >= 300) {
                        const error = new Error('对象存储上传失败（HTTP ' + response.status + '）')
                        error.status = Number(response.status) || 0
                        reject(error)
                        return
                    }
                    let payload = null
                    try { payload = JSON.parse(response.responseText || '{}') } catch (error) {}
                    if (payload && payload.state === false) {
                        const error = new Error(payload.error_msg || payload.message || '115 回调报告上传失败')
                        error.status = Number(response.status) || 0
                        reject(error)
                        return
                    }
                    resolve(response)
                },
                ontimeout: () => reject(Object.assign(new Error('本地文件上传超时'), { status: 0 })),
                onerror: () => reject(Object.assign(new Error('本地文件上传失败（网络或跨域被拦截）'), { status: 0 }))
            })
        })
    }

    async function find115FileInFolder(parentCid, name) {
        const items = await request115FolderChildren(parentCid)
        return find115LocalSyncRemoteByName(items, name)
    }

    async function waitFor115FileInFolder(parentCid, name, onCheck) {
        let attempt = 0
        while (true) {
            attempt += 1
            try {
                const remote = await find115FileInFolder(parentCid, name)
                if (remote) return remote
                if (typeof onCheck === 'function') onCheck(attempt, null)
            } catch (error) {
                const status = Number(error && error.status) || 0
                const permanentClientError = status >= 400 && status < 500 && status !== 429
                if (error && error.type === 'auth' || permanentClientError) throw error
                if (typeof onCheck === 'function') onCheck(attempt, error)
            }
            await new Promise(resolve => setTimeout(resolve, 60000))
        }
    }

    function describe115UploadFailure(error, uploadResponse, fileName) {
        const message = error && error.message ? error.message : String(error || '未知错误')
        const status = Number((error && error.status) || (uploadResponse && uploadResponse.status) || 0)
        const suffix = status ? '；最后HTTP状态 ' + status : ''
        return '115未确认文件入库：' + fileName + '。' + message + suffix + '。请以目标文件夹为准，不要按“已提交”判断成功'
    }

    async function delete115LocalSyncFile(item, parentCid) {
        if (!item || !item.fileId) throw new Error('115没有返回旧字幕的文件ID，无法安全替换')
        const body = new URLSearchParams({
            pid: String(parentCid || item.parentCid || '0'),
            'fid[0]': String(item.fileId)
        }).toString()
        await request115JsonWithPageFallback('POST', 'https://webapi.115.com/rb/delete', body)
    }

    async function rename115LocalSyncFile(item, name) {
        if (!item || !item.fileId) throw new Error('115没有返回临时字幕的文件ID，无法完成替换')
        const body = new URLSearchParams([[ 'files_new_name[' + String(item.fileId) + ']', String(name) ]]).toString()
        await request115JsonWithPageFallback('POST', 'https://webapi.115.com/files/batch_rename', body)
    }

    async function uploadLocalSyncFile(result, folderCid, onProgress, replaceRemote, onCheck) {
        const record = result.record
        const file = record.fileHandle && record.fileHandle.getFile ? await record.fileHandle.getFile() : record.file
        if (!file || !file.size) throw new Error('无法读取本地文件：' + record.name)
        const shouldReplace = Boolean(replaceRemote && record.kind === 'subtitle')
        const extensionIndex = record.name.lastIndexOf('.')
        const extension = extensionIndex > 0 ? record.name.slice(extensionIndex) : ''
        const stem = extensionIndex > 0 ? record.name.slice(0, extensionIndex) : record.name
        const tempName = shouldReplace ? stem + '.syncing-' + Date.now() + extension : record.name
        const uploadFile = shouldReplace
            ? new File([file], tempName, { type: file.type || 'application/octet-stream', lastModified: file.lastModified })
            : file
        const uploadInfo = await init115LocalSyncUpload(uploadFile, folderCid)
        const uploadResponse = uploadInfo.instant
            ? { status: 200, instant: true }
            : await uploadLocalSyncToOss(uploadFile, uploadInfo, onProgress)
        const uploadedName = shouldReplace ? tempName : record.name
        let remote = null
        try {
            remote = await waitFor115FileInFolder(folderCid, uploadedName, onCheck)
        } catch (error) {
            throw new Error(describe115UploadFailure(error, uploadResponse, uploadedName))
        }
        if (!remote) throw new Error(describe115UploadFailure(null, uploadResponse, uploadedName))
        if (shouldReplace) {
            await delete115LocalSyncFile(replaceRemote, folderCid)
            await rename115LocalSyncFile(remote, record.name)
            const finalRemote = await waitFor115FileInFolder(folderCid, record.name, onCheck)
            if (!finalRemote) throw new Error('旧字幕已处理，但替换后的同名字幕未确认入库')
            return finalRemote
        }
        return remote
    }

    function normalize115SubtitleFileName(name) {
        let value = String(name || '字幕').trim() || '字幕'
        value = value.replace(/[<>:"/\\|?*]/g, '_')
        return /\.(srt|ass|ssa|vtt|sup)$/i.test(value) ? value : value + '.srt'
    }

    async function find115SubtitleFolder(parentCid, folderName) {
        const direct = await find115FolderByName(parentCid, folderName)
        if (direct && direct.folderCid) return direct
        // 有些 115 页面接口只返回当前列表的文件，不返回目录；根目录再用搜索接口兜底。
        if (String(parentCid || '0') !== '0') return null
        const keys = get115SearchKeywords(folderName)
        const searchTerms = Array.from(new Set([keys.exact, keys.fallback, folderName].filter(Boolean)))
        for (const searchTerm of searchTerms) {
            const candidates = (await request115CloudSearch(searchTerm)).map(normalize115File)
            const found = find115SubtitleFolderFromNormalizedResults(candidates, folderName)
            if (found && found.folderCid) return found
        }
        return null
    }

    async function saveSubtitleTo115SameNumberFolder(payload) {
        const data = payload || {}
        const code = String(data.code || '').trim().toUpperCase()
        const text = String(data.text || '')
        if (!/^[A-Z]{2,10}-\d{2,8}$/.test(code)) throw new Error('无法识别当前页面番号')
        if (!text.trim()) throw new Error('字幕内容为空，无法上传')
        const targetCid = getLocalSyncTargetCid()
        let stage = '查找同番号文件夹'
        let folder
        try {
            folder = await find115SubtitleFolder(targetCid, code)
        } catch (error) {
            error.message = stage + '失败：' + (error.message || '未知错误')
            throw error
        }
        if (!folder || !folder.folderCid) {
            const error = new Error('115中没有找到同番号文件夹，请先下载视频')
            error.code = 'folder-missing'
            throw error
        }
        const fileName = normalize115SubtitleFileName(data.name)
        stage = '检查字幕是否已存在'
        let existing
        try {
            existing = await find115FileInFolder(folder.folderCid, fileName)
        } catch (error) {
            error.message = stage + '失败：' + (error.message || '未知错误')
            throw error
        }
        if (existing) return { status: 'exists', fileName: fileName, folderName: folder.name, folderCid: folder.folderCid }
        const file = new File([text], fileName, { type: 'text/plain;charset=utf-8', lastModified: Date.now() })
        stage = '上传并核对字幕入库'
        let result
        try {
            result = await uploadLocalSyncFile({
                record: { file: file, fileHandle: null, name: fileName, kind: 'subtitle', size: file.size }
            }, folder.folderCid, null, null, null)
        } catch (error) {
            error.message = stage + '失败：' + (error.message || '未知错误')
            throw error
        }
        notifyLocalSyncChanged()
        return { status: 'uploaded', fileName: fileName, folderName: folder.name, folderCid: folder.folderCid, remote: result }
    }

    // 字幕搜索区通过这个桥接复用同一套 115 上传与入库核对逻辑。
    // 同时写入 unsafeWindow，兼容部分油猴管理器将两个 IIFE 放在不同窗口代理中的情况。
    window.__missav115SaveSubtitle = saveSubtitleTo115SameNumberFolder
    try {
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) {
            unsafeWindow.__missav115SaveSubtitle = saveSubtitleTo115SameNumberFolder
        }
    } catch (error) {}

    function ensureLocalSyncChannel() {
        if (localSyncChannel || typeof BroadcastChannel !== 'function') return localSyncChannel
        try {
            localSyncChannel = new BroadcastChannel(LOCAL_SYNC_CHANNEL)
            localSyncChannel.addEventListener('message', event => {
                const data = event && event.data || {}
                if (data.type !== 'local-sync-changed') return
                if (localSyncState && localSyncState.directories && localSyncState.directories.length) {
                    localSyncState.remoteChanged = true
                }
            })
        } catch (error) { localSyncChannel = null }
        return localSyncChannel
    }

    function applyLocalSyncRemoteToSameName(state, sourceItem, remote, status) {
        if (!state || !sourceItem || !sourceItem.record) return
        const key = get115FileNameKey(sourceItem.record.name)
        ;(state.matches || []).forEach(item => {
            if (!item || !item.record || get115FileNameKey(item.record.name) !== key) return
            item.remote = remote || item.remote || null
            item.exists = true
            item.replaceExisting = false
            item.status = item === sourceItem ? (status || 'synced') : 'exists'
            item.error = ''
            item.selected = true
        })
    }

    function notifyLocalSyncChanged() {
        const channel = ensureLocalSyncChannel()
        if (!channel) return
        try { channel.postMessage({ type: 'local-sync-changed', at: Date.now() }) } catch (error) {}
    }

    function ensure115LocalSyncStyles() {
        if (document.getElementById('missav-115-local-sync-styles')) return
        const style = document.createElement('style')
        style.id = 'missav-115-local-sync-styles'
        style.textContent = [
            '#missav-115-local-sync-card{position:fixed;top:16px;right:16px;left:auto;z-index:2147483645;width:310px;height:400px;min-width:280px;min-height:220px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);resize:both;overflow:auto;box-sizing:border-box;padding:12px;border:1px solid #38bdf8;border-radius:10px;background:linear-gradient(145deg,#0b1d2a,#111827);color:#e5eef7;font:12px/1.45 Arial,sans-serif;box-shadow:0 8px 26px rgba(0,0,0,.35);}',
            '#missav-115-local-sync-card.hidden{display:none!important;}',
            '#missav-115-local-sync-toggle{position:fixed;top:42%;right:0;z-index:2147483644;width:42px;min-height:92px;padding:8px 5px;border:1px solid #38bdf8;border-right:0;border-radius:10px 0 0 10px;background:linear-gradient(145deg,#0b1d2a,#0ea5e9);color:#e0f2fe;font:700 12px/1.2 Arial,sans-serif;writing-mode:vertical-rl;cursor:grab;touch-action:none;user-select:none;box-shadow:0 8px 24px rgba(0,0,0,.32);}',
            '#missav-115-local-sync-toggle.hidden{display:none!important;}',
            '#missav-115-local-sync-toggle.dragging{cursor:grabbing;opacity:.85;}',
            '.missav-115-local-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;color:#bae6fd;font-weight:800;cursor:move;touch-action:none;user-select:none;}',
            '.missav-115-local-close{border:0;background:transparent;color:#cbd5e1;font-size:18px;line-height:1;cursor:pointer;padding:0 2px;}',
            '.missav-115-local-status{padding:7px 8px;border-radius:6px;background:rgba(15,23,42,.75);color:#cbd5e1;white-space:pre-line;}',
            '.missav-115-local-status.ok{color:#bbf7d0;}.missav-115-local-status.warn{color:#fde68a;}.missav-115-local-status.error{color:#fecaca;}',
            '.missav-115-local-controls{display:grid;gap:6px;margin-top:8px;}',
            '.missav-115-local-row{display:flex;align-items:center;gap:6px;}',
            '.missav-115-local-directories{display:grid;gap:4px;margin-top:2px;}',
            '.missav-115-local-dir{display:flex;align-items:center;gap:4px;padding:4px 6px;border:1px solid rgba(56,189,248,.2);border-radius:5px;background:rgba(15,23,42,.5);cursor:grab;}',
            '.missav-115-local-dir.dragging{opacity:.5;}.missav-115-local-dir.drag-over{border-color:#facc15;background:rgba(250,204,21,.12);}',
            '.missav-115-local-dir-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cbd5e1;}',
            '.missav-115-local-dir-action{border:0;border-radius:3px;padding:2px 5px;background:#475569;color:#e2e8f0;font-size:10px;cursor:pointer;}.missav-115-local-dir-action:disabled{opacity:.35;cursor:not-allowed;}',
            '.missav-115-local-button{min-height:28px;padding:0 8px;border:0;border-radius:5px;background:#0ea5e9;color:#082f49;font-size:11px;font-weight:700;cursor:pointer;}',
            '.missav-115-local-button.secondary{background:#334155;color:#e2e8f0;}.missav-115-local-button.success{background:#22c55e;color:#052e16;}.missav-115-local-button:disabled{opacity:.5;cursor:not-allowed;}',
            '.missav-115-local-input{min-width:0;flex:1;height:28px;padding:0 7px;border:1px solid #475569;border-radius:5px;background:#0f172a;color:#e2e8f0;font-size:11px;}',
            '.missav-115-local-list{display:grid;gap:6px;margin-top:9px;}',
            '.missav-115-local-group{padding:7px;border:1px solid rgba(56,189,248,.25);border-radius:7px;background:rgba(15,23,42,.62);}',
            '.missav-115-local-group-head{display:flex;align-items:center;justify-content:space-between;gap:6px;color:#bae6fd;font-weight:800;cursor:pointer;list-style:none;}.missav-115-local-group-head::-webkit-details-marker{display:none;}',
            '.missav-115-local-group-sync{border:0;border-radius:4px;padding:3px 6px;background:#38bdf8;color:#082f49;font-size:10px;cursor:pointer;}',
            '.missav-115-local-file{display:flex;align-items:center;gap:5px;margin-top:5px;padding-top:5px;border-top:1px solid rgba(148,163,184,.13);}',
            '.missav-115-local-file.priority{border-left:3px solid #facc15;padding-left:4px;background:rgba(250,204,21,.08);}',
            '.missav-115-local-file-info{min-width:0;flex:1;display:grid;gap:2px;}',
            '.missav-115-local-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e2e8f0;}',
            '.missav-115-local-file-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#94a3b8;font-size:10px;}',
            '.missav-115-local-file-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#a5b4fc;font-size:10px;}',
            '.missav-115-local-file-state{color:#facc15;font-size:10px;white-space:nowrap;}.missav-115-local-file-state.exists,.missav-115-local-file-state.synced{color:#86efac;}.missav-115-local-file-state.replace{color:#f9a8d4;}.missav-115-local-file-state.error{color:#fca5a5;}',
            '.missav-115-local-file-sync{border:0;border-radius:4px;padding:3px 6px;background:#fbbf24;color:#1f2937;font-size:10px;cursor:pointer;white-space:nowrap;}',
            '.missav-115-local-filter{display:flex;align-items:center;gap:5px;margin-top:7px;color:#cbd5e1;font-size:11px;}',
            '.missav-115-local-filter input{margin:0;accent-color:#22c55e;}',
            '.missav-115-local-excluded{display:none;margin-top:7px;padding:6px;border:1px solid rgba(248,113,113,.28);border-radius:6px;background:rgba(69,10,10,.25);}',
            '.missav-115-local-excluded.open{display:grid;gap:4px;}',
            '.missav-115-local-excluded-row{display:flex;align-items:center;gap:5px;color:#fecaca;font-size:10px;}',
            '.missav-115-local-excluded-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.missav-115-local-empty{padding:10px 4px;color:#94a3b8;text-align:center;font-size:11px;}',
            '.missav-115-local-hint{margin-top:8px;color:#8fa6b8;font-size:10px;line-height:1.4;}',
            '@media(max-width:560px){#missav-115-local-sync-card{top:10px;right:10px;width:calc(100vw - 20px);}.missav-115-local-list{max-height:270px;overflow:auto;}}'
        ].join('\n')
        document.head.appendChild(style)
    }

    function formatLocalSyncSize(size) {
        const value = Number(size) || 0
        if (!value) return '0 B'
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        let index = 0
        let current = value
        while (current >= 1024 && index < units.length - 1) { current /= 1024; index += 1 }
        return current.toFixed(index ? (current >= 10 ? 1 : 2) : 0) + ' ' + units[index]
    }

    function create115LocalSyncElement(previousState) {
        ensure115LocalSyncStyles()
        const state = previousState || {
            directories: [], records: [], matches: [], scanning: false, syncing: false, remoteChanged: false,
            folderPromises: new Map(), collapsedGroups: {}, scanAndRender: null, renderCurrent: null, setStatusCurrent: null,
            statusText: '请选择要检查的本地目录', statusType: 'warn',
            hideExisting: getLocalSyncBooleanSetting(LOCAL_SYNC_HIDE_EXISTING_KEY, false),
            parentRenameSync: getLocalSyncBooleanSetting(LOCAL_SYNC_PARENT_RENAME_SYNC_KEY, false),
            showExcluded: false, excluded: loadLocalSyncExclusions()
        }
        state.folderPromises = state.folderPromises || new Map()
        state.collapsedGroups = state.collapsedGroups || {}
        state.parentRenameSync = Boolean(state.parentRenameSync)
        state.excluded = state.excluded || loadLocalSyncExclusions()
        state.showExcluded = false
        localSyncState = state
        ensureLocalSyncChannel()
        const card = document.createElement('section')
        card.id = 'missav-115-local-sync-card'
        card.className = 'hidden'
        const savedCardTop = readLocalSyncSetting(LOCAL_SYNC_CARD_TOP_KEY, '')
        const savedCardLeft = readLocalSyncSetting(LOCAL_SYNC_CARD_LEFT_KEY, '')
        if (/^\d+(?:\.\d+)?px$/.test(String(savedCardTop))) card.style.top = String(savedCardTop)
        if (/^\d+(?:\.\d+)?px$/.test(String(savedCardLeft))) {
            card.style.left = String(savedCardLeft)
            card.style.right = 'auto'
        }
        const toggle = document.createElement('button')
        toggle.id = 'missav-115-local-sync-toggle'
        toggle.type = 'button'
        toggle.textContent = '115同步'
        toggle.title = '打开115本地同步面板'
        toggle.setAttribute('aria-expanded', 'false')
        const savedToggleTop = readLocalSyncSetting(LOCAL_SYNC_TOGGLE_TOP_KEY, '')
        const savedToggleLeft = readLocalSyncSetting(LOCAL_SYNC_TOGGLE_LEFT_KEY, '')
        if (/^\d+(?:\.\d+)?px$/.test(String(savedToggleTop))) {
            toggle.style.top = String(savedToggleTop)
            toggle.style.transform = 'none'
        }
        if (/^\d+(?:\.\d+)?px$/.test(String(savedToggleLeft))) {
            toggle.style.left = String(savedToggleLeft)
            toggle.style.right = 'auto'
            toggle.style.transform = 'none'
        }
        let toggleDragging = false
        let toggleMoved = false
        let toggleStartX = 0
        let toggleStartY = 0
        let toggleStartLeft = 0
        let toggleStartTop = 0
        toggle.addEventListener('pointerdown', event => {
            if (event.button !== undefined && event.button !== 0) return
            const rect = toggle.getBoundingClientRect()
            toggleDragging = true
            toggleMoved = false
            toggleStartX = event.clientX
            toggleStartY = event.clientY
            toggleStartLeft = rect.left
            toggleStartTop = rect.top
            toggle.classList.add('dragging')
            toggle.setPointerCapture?.(event.pointerId)
            event.preventDefault()
        })
        toggle.addEventListener('pointermove', event => {
            if (!toggleDragging) return
            const dx = event.clientX - toggleStartX
            const dy = event.clientY - toggleStartY
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) toggleMoved = true
            if (!toggleMoved) return
            const left = Math.max(0, Math.min(window.innerWidth - toggle.offsetWidth, toggleStartLeft + dx))
            const top = Math.max(0, Math.min(window.innerHeight - toggle.offsetHeight, toggleStartTop + dy))
            toggle.style.left = Math.round(left) + 'px'
            toggle.style.top = Math.round(top) + 'px'
            toggle.style.right = 'auto'
            toggle.style.transform = 'none'
            event.preventDefault()
        })
        const finishToggleDrag = event => {
            if (!toggleDragging) return
            toggleDragging = false
            toggle.classList.remove('dragging')
            toggle.releasePointerCapture?.(event.pointerId)
            if (toggleMoved) {
                writeLocalSyncSetting(LOCAL_SYNC_TOGGLE_TOP_KEY, toggle.style.top)
                writeLocalSyncSetting(LOCAL_SYNC_TOGGLE_LEFT_KEY, toggle.style.left)
                toggle.dataset.dragMoved = '1'
                setTimeout(() => { delete toggle.dataset.dragMoved }, 0)
            }
        }
        toggle.addEventListener('pointerup', finishToggleDrag)
        toggle.addEventListener('pointercancel', finishToggleDrag)
        const head = document.createElement('div')
        head.className = 'missav-115-local-head'
        const title = document.createElement('span')
        title.textContent = '115 · 本地视频/字幕同步'
        head.appendChild(title)
        let cardDragging = false
        let cardMoved = false
        let cardStartX = 0
        let cardStartY = 0
        let cardStartLeft = 0
        let cardStartTop = 0
        head.addEventListener('pointerdown', event => {
            if (event.button !== undefined && event.button !== 0) return
            if (event.target.closest('button, input, select, textarea')) return
            const rect = card.getBoundingClientRect()
            cardDragging = true
            cardMoved = false
            cardStartX = event.clientX
            cardStartY = event.clientY
            cardStartLeft = rect.left
            cardStartTop = rect.top
            card.setPointerCapture?.(event.pointerId)
            event.preventDefault()
        })
        head.addEventListener('pointermove', event => {
            if (!cardDragging) return
            const dx = event.clientX - cardStartX
            const dy = event.clientY - cardStartY
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) cardMoved = true
            if (!cardMoved) return
            const left = Math.max(0, Math.min(window.innerWidth - card.offsetWidth, cardStartLeft + dx))
            const top = Math.max(0, Math.min(window.innerHeight - card.offsetHeight, cardStartTop + dy))
            card.style.left = Math.round(left) + 'px'
            card.style.top = Math.round(top) + 'px'
            card.style.right = 'auto'
            event.preventDefault()
        })
        const finishCardDrag = event => {
            if (!cardDragging) return
            cardDragging = false
            card.releasePointerCapture?.(event.pointerId)
            if (cardMoved) {
                writeLocalSyncSetting(LOCAL_SYNC_CARD_TOP_KEY, card.style.top)
                writeLocalSyncSetting(LOCAL_SYNC_CARD_LEFT_KEY, card.style.left)
            }
        }
        head.addEventListener('pointerup', finishCardDrag)
        head.addEventListener('pointercancel', finishCardDrag)
        const close = document.createElement('button')
        close.className = 'missav-115-local-close'
        close.type = 'button'
        close.textContent = '×'
        close.title = '隐藏面板'
        const setPanelOpen = open => {
            const shouldOpen = Boolean(open)
            card.classList.toggle('hidden', !shouldOpen)
            toggle.setAttribute('aria-expanded', String(shouldOpen))
            toggle.title = shouldOpen ? '收起115本地同步面板' : '打开115本地同步面板'
        }
        close.addEventListener('click', event => {
            event.preventDefault()
            event.stopPropagation()
            setPanelOpen(false)
        })
        head.appendChild(close)
        card.appendChild(head)

        const status = document.createElement('div')
        status.className = 'missav-115-local-status warn'
        status.textContent = '请选择要检查的本地目录'
        card.appendChild(status)
        const controls = document.createElement('div')
        controls.className = 'missav-115-local-controls'
        const directoryRow = document.createElement('div')
        directoryRow.className = 'missav-115-local-row'
        const chooseButton = document.createElement('button')
        chooseButton.className = 'missav-115-local-button'
        chooseButton.type = 'button'
        chooseButton.textContent = '添加本地目录'
        const rescanButton = document.createElement('button')
        rescanButton.className = 'missav-115-local-button secondary'
        rescanButton.type = 'button'
        rescanButton.textContent = '手动扫描'
        rescanButton.disabled = true
        directoryRow.append(chooseButton, rescanButton)
        controls.appendChild(directoryRow)
        const directoryList = document.createElement('div')
        directoryList.className = 'missav-115-local-directories'
        controls.appendChild(directoryList)
        const targetRow = document.createElement('div')
        targetRow.className = 'missav-115-local-row'
        const targetLabel = document.createElement('span')
        targetLabel.textContent = '目标CID'
        const targetInput = document.createElement('input')
        targetInput.className = 'missav-115-local-input'
        targetInput.value = getLocalSyncTargetCid()
        targetInput.placeholder = '填“云下载”或已有目录CID'
        targetInput.title = '选择115“云下载”目录可按番号创建子目录；其他已有目录直接作为上传位置；禁止选择根目录CID 0'
        targetRow.append(targetLabel, targetInput)
        controls.appendChild(targetRow)
        const syncRow = document.createElement('div')
        syncRow.className = 'missav-115-local-row'
        const syncSelected = document.createElement('button')
        syncSelected.className = 'missav-115-local-button success'
        syncSelected.type = 'button'
        syncSelected.textContent = '同步选中'
        const syncAll = document.createElement('button')
        syncAll.className = 'missav-115-local-button success'
        syncAll.type = 'button'
        syncAll.textContent = '同步全部待同步'
        syncSelected.disabled = true
        syncAll.disabled = true
        syncRow.append(syncSelected, syncAll)
        controls.appendChild(syncRow)

        const filterRow = document.createElement('div')
        filterRow.className = 'missav-115-local-filter'
        const hideExistingInput = document.createElement('input')
        hideExistingInput.type = 'checkbox'
        hideExistingInput.checked = Boolean(state.hideExisting)
        const hideExistingLabel = document.createElement('label')
        hideExistingLabel.textContent = '只显示待同步文件'
        hideExistingLabel.prepend(hideExistingInput)
        filterRow.appendChild(hideExistingLabel)
        const excludedToggle = document.createElement('button')
        excludedToggle.className = 'missav-115-local-dir-action'
        excludedToggle.type = 'button'
        excludedToggle.textContent = '排除历史'
        excludedToggle.title = '查看或恢复已排除的文件'
        filterRow.appendChild(excludedToggle)
        const followRenameInput = document.createElement('input')
        followRenameInput.type = 'checkbox'
        followRenameInput.checked = Boolean(state.parentRenameSync)
        const followRenameLabel = document.createElement('label')
        followRenameLabel.title = '在115网盘内重命名视频文件后，将其所在的上级目录改为视频文件名（不含扩展名）'
        followRenameLabel.textContent = '视频改名同步上级目录'
        followRenameLabel.prepend(followRenameInput)
        filterRow.appendChild(followRenameLabel)
        controls.appendChild(filterRow)
        card.appendChild(controls)

        const excludedHistory = document.createElement('div')
        excludedHistory.className = 'missav-115-local-excluded'
        card.appendChild(excludedHistory)
        const list = document.createElement('div')
        list.className = 'missav-115-local-list'
        card.appendChild(list)
        const hint = document.createElement('div')
        hint.className = 'missav-115-local-hint'
        hint.textContent = '仅手动扫描；新添加目录默认最高优先级。仅在“云下载”下创建番号文件夹，其他已有目录直接作为上传位置，禁止使用根目录。同步后以目标文件夹中的实际文件为准。改名开关只处理115内的视频文件。'
        card.appendChild(hint)
        toggle.addEventListener('click', event => {
            if (toggle.dataset.dragMoved === '1') {
                event.preventDefault()
                event.stopPropagation()
                return
            }
            event.preventDefault()
            event.stopPropagation()
            setPanelOpen(card.classList.contains('hidden'))
        })
        document.documentElement.appendChild(toggle)
        document.documentElement.appendChild(card)
        restore115CardSize(card)

        const setStatus = (text, type) => {
            state.statusText = String(text || '')
            state.statusType = type || ''
            status.className = 'missav-115-local-status ' + (type || '')
            status.textContent = state.statusText
        }
        state.setStatusCurrent = setStatus
        setStatus(state.statusText || '请选择要检查的本地目录', state.statusType || 'warn')
        const persistDirectories = () => saveLocalSyncDirectoryHandles(state.directories).catch(error => {
            setStatus('目录顺序已更新，但保存失败：' + (error && error.message || error || '未知错误'), 'error')
        })
        const reorderDirectories = (fromIndex, targetIndex) => {
            if (fromIndex === targetIndex || fromIndex < 0 || targetIndex < 0 || fromIndex >= state.directories.length || targetIndex >= state.directories.length) return
            const [entry] = state.directories.splice(fromIndex, 1)
            state.directories.splice(targetIndex, 0, entry)
            state.matches = []; state.records = []
            persistDirectories(); renderDirectories(); render()
            setStatus('目录优先级已调整，请点击“手动扫描”更新结果', 'warn')
        }
        const renderDirectories = () => {
            directoryList.replaceChildren()
            let draggedIndex = -1
            state.directories.forEach((entry, index) => {
                const row = document.createElement('div')
                row.className = 'missav-115-local-dir'
                row.draggable = true
                row.title = '按住拖动可调整目录优先级'
                row.addEventListener('dragstart', event => {
                    draggedIndex = index
                    row.classList.add('dragging')
                    if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', String(index))
                    }
                })
                row.addEventListener('dragover', event => {
                    event.preventDefault()
                    if (draggedIndex !== index) row.classList.add('drag-over')
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
                })
                row.addEventListener('dragleave', () => row.classList.remove('drag-over'))
                row.addEventListener('drop', event => {
                    event.preventDefault()
                    row.classList.remove('drag-over')
                    const fromIndex = draggedIndex >= 0 ? draggedIndex : Number(event.dataTransfer && event.dataTransfer.getData('text/plain'))
                    reorderDirectories(fromIndex, index)
                    draggedIndex = -1
                })
                row.addEventListener('dragend', () => {
                    draggedIndex = -1
                    row.classList.remove('dragging')
                    directoryList.querySelectorAll('.drag-over').forEach(item => item.classList.remove('drag-over'))
                })
                const name = document.createElement('span')
                name.className = 'missav-115-local-dir-name'
                name.textContent = (index + 1) + '. ' + entry.name + (index === 0 ? '（最高优先级）' : '')
                name.title = '拖动本行调整优先级：' + entry.name
                row.appendChild(name)
                const up = document.createElement('button')
                up.className = 'missav-115-local-dir-action'
                up.type = 'button'
                up.textContent = '↑'
                up.title = '提高优先级'
                up.disabled = index === 0
                up.addEventListener('click', () => {
                    reorderDirectories(index, index - 1)
                })
                row.appendChild(up)
                const down = document.createElement('button')
                down.className = 'missav-115-local-dir-action'
                down.type = 'button'
                down.textContent = '↓'
                down.title = '降低优先级'
                down.disabled = index === state.directories.length - 1
                down.addEventListener('click', () => {
                    reorderDirectories(index, index + 1)
                })
                row.appendChild(down)
                const remove = document.createElement('button')
                remove.className = 'missav-115-local-dir-action'
                remove.type = 'button'
                remove.textContent = '移除'
                remove.title = '移除目录授权'
                remove.addEventListener('click', () => {
                    state.directories.splice(index, 1)
                    state.matches = []; state.records = []
                    persistDirectories(); renderDirectories(); render();
                    setStatus(state.directories.length ? '目录已移除，请点击“手动扫描”更新结果' : '请添加至少一个本地目录', 'warn')
                })
                row.appendChild(remove)
                directoryList.appendChild(row)
            })
        }
        const isItemExcluded = item => Boolean(item && (item.excluded || state.excluded[getLocalSyncRecordKey(item.record)]))
        const isExistingItem = item => Boolean(item && (item.exists || item.status === 'exists' || item.status === 'synced'))
        const getPending = () => state.matches.filter(item => !isItemExcluded(item) && !item.exists && ['pending', 'replace', 'failed', 'check-error'].includes(item.status))
        const renderExcludedHistory = () => {
            const entries = Object.values(state.excluded || {}).sort((a, b) => Number(b.excludedAt || 0) - Number(a.excludedAt || 0))
            excludedToggle.textContent = entries.length ? '排除历史（' + entries.length + '）' : '排除历史'
            excludedHistory.classList.toggle('open', Boolean(state.showExcluded))
            excludedHistory.replaceChildren()
            if (!state.showExcluded) return
            if (!entries.length) {
                const empty = document.createElement('div')
                empty.className = 'missav-115-local-empty'
                empty.textContent = '暂无排除记录'
                excludedHistory.appendChild(empty)
                return
            }
            entries.forEach(entry => {
                const row = document.createElement('div')
                row.className = 'missav-115-local-excluded-row'
                const name = document.createElement('span')
                name.className = 'missav-115-local-excluded-name'
                name.textContent = (entry.code ? entry.code + ' · ' : '') + (entry.name || entry.relativePath || '未命名文件')
                name.title = [entry.sourceName, entry.relativePath].filter(Boolean).join(' / ')
                row.appendChild(name)
                const restore = document.createElement('button')
                restore.className = 'missav-115-local-dir-action'
                restore.type = 'button'
                restore.textContent = '恢复'
                restore.addEventListener('click', () => {
                    delete state.excluded[entry.key]
                    state.matches.forEach(item => {
                        if (getLocalSyncRecordKey(item.record) === entry.key) item.excluded = false
                    })
                    saveLocalSyncExclusions(state.excluded)
                    render()
                    setStatus('已恢复：' + (entry.name || '该文件') + '，现在可以同步', 'ok')
                })
                row.appendChild(restore)
                excludedHistory.appendChild(row)
            })
        }
        const render = () => {
            list.replaceChildren()
            const groups = new Map()
            state.matches.forEach(item => {
                if (isItemExcluded(item)) return
                if (state.hideExisting && isExistingItem(item)) return
                if (!groups.has(item.record.code)) groups.set(item.record.code, [])
                groups.get(item.record.code).push(item)
            })
            renderExcludedHistory()
            if (!groups.size) {
                const empty = document.createElement('div')
                empty.className = 'missav-115-local-empty'
                empty.textContent = state.matches.length
                    ? (state.hideExisting ? '没有待同步文件；可取消“只显示待同步文件”查看已存在文件' : '当前文件均已排除')
                    : '请添加目录并点击“手动扫描”'
                list.appendChild(empty)
            }
            groups.forEach((items, code) => {
                const group = document.createElement('details')
                group.className = 'missav-115-local-group'
                group.open = state.collapsedGroups[code] !== true
                group.addEventListener('toggle', () => { state.collapsedGroups[code] = !group.open })
                const groupHead = document.createElement('summary')
                groupHead.className = 'missav-115-local-group-head'
                groupHead.addEventListener('click', event => {
                    if (event.target.closest('button')) event.preventDefault()
                })
                const groupTitle = document.createElement('span')
                groupTitle.textContent = code + ' · ' + items.length + ' 个文件'
                const groupButton = document.createElement('button')
                groupButton.className = 'missav-115-local-group-sync'
                groupButton.type = 'button'
                groupButton.textContent = '同步该番号'
                groupButton.disabled = state.syncing || !items.some(item => !item.exists && ['pending', 'replace', 'failed', 'check-error'].includes(item.status))
                groupButton.addEventListener('click', event => {
                    event.preventDefault()
                    event.stopPropagation()
                    syncItems(items)
                })
                groupHead.append(groupTitle, groupButton)
                group.appendChild(groupHead)
                items.forEach(item => {
                    const row = document.createElement('div')
                    row.className = 'missav-115-local-file' + (item.record.isPriorityDuplicate ? ' priority' : '')
                    const checkbox = document.createElement('input')
                    checkbox.type = 'checkbox'
                    const alreadyExists = isExistingItem(item)
                    checkbox.checked = alreadyExists || Boolean(item.selected)
                    checkbox.disabled = state.syncing || alreadyExists || item.status === 'syncing'
                    checkbox.addEventListener('change', () => { item.selected = checkbox.checked; updateButtons() })
                    row.appendChild(checkbox)
                    const info = document.createElement('div')
                    info.className = 'missav-115-local-file-info'
                    const name = document.createElement('span')
                    name.className = 'missav-115-local-file-name'
                    name.textContent = item.record.name
                    name.title = item.record.relativePath
                    info.appendChild(name)
                    const path = document.createElement('span')
                    path.className = 'missav-115-local-file-path'
                    path.textContent = [item.record.sourceName, item.record.relativePath].filter(Boolean).join('\\')
                    path.title = path.textContent
                    info.appendChild(path)
                    const meta = document.createElement('span')
                    meta.className = 'missav-115-local-file-meta'
                    const priorityText = item.record.isPriorityDuplicate ? ' · 高优先级目录' : ''
                    const remoteText = item.remote
                        ? ' · 115 ' + format115FileSize(item.remote.sizeBytes) + ' · ' + item.remote.name
                        : ''
                    meta.textContent = (item.record.kind === 'video' ? '视频 ' : '字幕 ') + '本地 ' + formatLocalSyncSize(item.record.size) + priorityText + remoteText
                    meta.title = item.remote && item.remote.name ? item.remote.name : ''
                    info.appendChild(meta)
                    row.appendChild(info)
                    const stateText = document.createElement('span')
                    stateText.className = 'missav-115-local-file-state ' + (item.status === 'exists' || item.status === 'synced' || item.status === 'replace' ? item.status : item.status === 'check-error' || item.status === 'failed' ? 'error' : '')
                    stateText.textContent = item.exists ? '已存在' : item.status === 'syncing' ? '同步中' : item.status === 'synced' ? '已同步' : item.status === 'replace' ? '优先替换' : item.status === 'check-error' ? '查询失败' : item.status === 'failed' ? '失败' : '待同步'
                    stateText.title = item.error || (item.remote && item.remote.name) || ''
                    row.appendChild(stateText)
                    if (!item.exists && item.status !== 'syncing') {
                        const syncButton = document.createElement('button')
                        syncButton.className = 'missav-115-local-file-sync'
                        syncButton.type = 'button'
                        syncButton.textContent = item.status === 'replace' ? '替换' : '同步'
                        syncButton.disabled = state.syncing || item.status === 'syncing'
                        syncButton.addEventListener('click', () => syncItems([item]))
                        row.appendChild(syncButton)
                        const excludeButton = document.createElement('button')
                        excludeButton.className = 'missav-115-local-dir-action'
                        excludeButton.type = 'button'
                        excludeButton.textContent = '排除'
                        excludeButton.title = '不再在主列表显示，也不会被批量同步'
                        excludeButton.addEventListener('click', () => {
                            const key = getLocalSyncRecordKey(item.record)
                            if (!key) return
                            state.excluded[key] = {
                                key: key,
                                code: item.record.code,
                                name: item.record.name,
                                relativePath: item.record.relativePath,
                                sourceName: item.record.sourceName,
                                excludedAt: Date.now()
                            }
                            item.excluded = true
                            item.selected = false
                            saveLocalSyncExclusions(state.excluded)
                            render()
                            setStatus('已排除：' + item.record.name + '，可在“排除历史”中恢复', 'ok')
                        })
                        row.appendChild(excludeButton)
                    }
                    group.appendChild(row)
                })
                list.appendChild(group)
            })
            updateButtons()
        }
        state.renderCurrent = render
        hideExistingInput.addEventListener('change', () => {
            state.hideExisting = hideExistingInput.checked
            writeLocalSyncSetting(LOCAL_SYNC_HIDE_EXISTING_KEY, state.hideExisting)
            render()
        })
        followRenameInput.addEventListener('change', () => {
            state.parentRenameSync = followRenameInput.checked
            state.folderPromises.clear()
            writeLocalSyncSetting(LOCAL_SYNC_PARENT_RENAME_SYNC_KEY, state.parentRenameSync)
            setStatus(state.parentRenameSync
                ? '已开启：115内重命名视频后，将同步修改上级目录名。'
                : '已关闭：115内重命名视频不会自动修改上级目录。', 'ok')
        })
        excludedToggle.addEventListener('click', () => {
            state.showExcluded = !state.showExcluded
            render()
        })
        const updateButtons = () => {
            const pending = getPending()
            syncSelected.disabled = state.syncing || !pending.some(item => item.selected)
            syncAll.disabled = state.syncing || pending.length === 0
            rescanButton.disabled = state.scanning || state.syncing || !state.directories.length
        }
        const syncItems = async items => {
            if (state.syncing || !state.directories.length) return
            const targetCid = String(targetInput.value || '').trim()
            if (!/^\d+$/.test(targetCid) || targetCid === '0') { state.setStatusCurrent('目标CID必须是非零数字；请选择“云下载”或其他已有目录', 'error'); return }
            saveLocalSyncTargetCid(targetCid)
            state.syncing = true
            updateButtons()
            try {
                for (const item of items) {
                    if (isItemExcluded(item) || item.exists || item.status === 'synced') continue
                    item.status = 'syncing'; item.error = ''; state.renderCurrent()
                    try {
                        const freshItems = await query115LocalSyncRemoteFiles(item.record.code)
                        const freshRemote = find115LocalSyncRemoteByRecord(freshItems, item.record)
                        const shouldReplace = Boolean(item.replaceExisting && item.record.kind === 'subtitle')
                        if (freshRemote && !shouldReplace) {
                            applyLocalSyncRemoteToSameName(state, item, freshRemote, 'exists')
                            state.renderCurrent(); continue
                        }
                        let folderPromise = state.folderPromises.get(item.record.code)
                        if (!folderPromise) {
                            const groupRecords = state.matches
                                .filter(match => match.record.code === item.record.code)
                                .map(match => match.record)
                            folderPromise = resolve115LocalSyncFolder(item.record.code, groupRecords, freshItems, targetCid)
                            state.folderPromises.set(item.record.code, folderPromise)
                        }
                        const folderCid = await folderPromise
                        const replaceRemote = shouldReplace ? await find115FileInFolder(folderCid, item.record.name) : null
                        item.remote = await uploadLocalSyncFile(item, folderCid, event => {
                            if (event && event.total) state.setStatusCurrent('正在上传 ' + item.record.name + '：' + Math.round(event.loaded / event.total * 100) + '%', 'warn')
                        }, replaceRemote, (attempt, error) => {
                            state.setStatusCurrent('持续检测 ' + item.record.name + ' 是否已完成（第 ' + attempt + ' 次）' + (error ? '，网络暂时异常，继续重试' : ''), 'warn')
                        })
                        applyLocalSyncRemoteToSameName(state, item, item.remote, 'synced')
                    } catch (error) {
                        item.status = 'failed'; item.error = error && error.message || String(error || '同步失败')
                    }
                    state.renderCurrent()
                }
                const failed = state.matches.filter(item => item.status === 'failed' || item.status === 'check-error').length
                state.setStatusCurrent(failed
                    ? '同步完成，但有 ' + failed + ' 个文件失败，请查看红色状态后重试'
                    : '同步完成：已有文件已跳过，已逐个确认写入目标文件夹（网页上传记录可能不显示）', failed ? 'warn' : 'ok')
                notifyLocalSyncChanged()
            } finally {
                state.syncing = false
                state.folderPromises.clear()
                state.renderCurrent()
            }
        }
        state.scanAndRender = async () => {
            if (state.scanning || state.syncing || !state.directories.length) return
            state.scanning = true; state.remoteChanged = false; updateButtons(); state.setStatusCurrent('正在扫描本地目录…', 'warn')
            try {
                state.records = await scanLocalSyncDirectories(state.directories)
                state.setStatusCurrent('已找到 ' + state.records.length + ' 个带番号的视频/字幕，正在反查115…', 'warn')
                state.matches = await find115LocalSyncMatches(state.records, (done, total, code, error) => {
                    state.setStatusCurrent('正在反查115：' + done + '/' + total + '（' + code + '）' + (error ? '\n' + (error.message || '查询失败') : ''), error ? 'error' : 'warn')
                })
                const existing = state.matches.filter(item => !isItemExcluded(item) && item.exists).length
                const replace = state.matches.filter(item => !isItemExcluded(item) && item.status === 'replace').length
                const pending = state.matches.filter(item => !isItemExcluded(item) && !item.exists && item.status === 'pending').length
                const failed = state.matches.filter(item => !isItemExcluded(item) && item.status === 'check-error').length
                state.setStatusCurrent('本地 ' + state.matches.length + ' 个文件：115已有 ' + existing + ' 个，优先替换字幕 ' + replace + ' 个，待同步 ' + pending + ' 个' + (failed ? '，查询失败 ' + failed + ' 个' : ''), failed ? 'warn' : 'ok')
                state.renderCurrent()
            } catch (error) {
                state.setStatusCurrent(error && error.message || String(error || '扫描失败'), 'error')
            } finally { state.scanning = false; updateButtons() }
        }
        chooseButton.addEventListener('click', async () => {
            try {
                chooseButton.disabled = true
                const handle = await chooseLocalSyncDirectory()
                let duplicate = false
                for (const entry of state.directories) {
                    if (entry && entry.handle && typeof handle.isSameEntry === 'function' && await handle.isSameEntry(entry.handle)) {
                        duplicate = true
                        break
                    }
                }
                if (duplicate) {
                    setStatus('这个目录已经添加过了，请直接点击“手动扫描”', 'warn')
                    return
                }
                state.directories.unshift({ handle: handle, name: String(handle.name || '本地目录') })
                state.matches = []; state.records = []
                await saveLocalSyncDirectoryHandles(state.directories)
                renderDirectories(); render(); updateButtons()
                setStatus('已添加目录：' + (handle.name || '本地目录') + '，当前为最高优先级。请点击“手动扫描”。', 'ok')
            } catch (error) { setStatus(error && error.message || String(error || '选择目录失败'), 'error') }
            finally { chooseButton.disabled = false; updateButtons() }
        })
        rescanButton.addEventListener('click', () => state.scanAndRender())
        targetInput.addEventListener('change', () => {
            if (!saveLocalSyncTargetCid(targetInput.value)) { targetInput.value = getLocalSyncTargetCid(); setStatus('目标CID必须是非零数字；根目录不允许作为同步目标', 'error') }
        })
        syncSelected.addEventListener('click', () => syncItems(state.matches.filter(item => item.selected && !item.exists && !isItemExcluded(item))))
        syncAll.addEventListener('click', () => syncItems(getPending()))
        loadLocalSyncDirectoryHandles().then(handles => {
            if (!state.directories.length) {
                state.directories = (Array.isArray(handles) ? handles : []).map(handle => ({
                    handle: handle,
                    name: String(handle && handle.name || '本地目录')
                }))
            }
            renderDirectories()
            updateButtons()
            state.renderCurrent()
            if (state.directories.length && !state.syncing) state.setStatusCurrent('已记住 ' + state.directories.length + ' 个目录，请点击“手动扫描”', 'warn')
        }).catch(() => {})
        return card
    }

    function cleanup115LocalSyncUi(keepCard, keepToggle) {
        document.querySelectorAll('#av-restore-btn, #av-main-panel, #missav-115-cloud-card').forEach(item => item.remove())
        document.querySelectorAll('[id*="115"][id*="toggle"], [id*="115"][id*="sidebar"], [id*="115"][id*="sync"]').forEach(item => {
            if (item === keepToggle || item === keepCard || item.id === 'missav-115-local-sync-styles') return
            item.remove()
        })
        document.querySelectorAll('button, [role="button"]').forEach(item => {
            if (item === keepToggle || item.closest('#missav-115-local-sync-card')) return
            if (String(item.textContent || '').trim() === '115同步') item.remove()
        })
        document.querySelectorAll('*').forEach(item => {
            if (item === keepCard || item === keepToggle || item.closest('#missav-115-local-sync-card')) return
            const text = String(item.textContent || '').replace(/\s+/g, ' ').trim()
            if (!text) return
            let rect = null
            let style = null
            try {
                style = window.getComputedStyle(item)
                rect = item.getBoundingClientRect()
            } catch (error) { return }
            if (style.position !== 'fixed') return
            const isLegacyToggle = text === '115同步' && rect.width <= 100 && rect.height <= 180
            const hasLegacySyncControls = text.includes('目标CID')
                && text.includes('同步选中')
                && text.includes('同步全部待同步')
            const hasLegacySyncTitle = /115\s*[·•]\s*本地视频\s*[\/／]?\s*字幕同步/i.test(text)
            const isLegacyCard = (hasLegacySyncTitle || hasLegacySyncControls) && rect.width >= 240 && rect.height >= 150
            if (isLegacyToggle || isLegacyCard) item.remove()
        })
    }

    function ensure115LocalSyncCard() {
        if (!is115UserPage() || !document.documentElement) return
        const cards = Array.from(document.querySelectorAll('#missav-115-local-sync-card'))
        const toggles = Array.from(document.querySelectorAll('#missav-115-local-sync-toggle'))
        cards.slice(1).forEach(item => item.remove())
        toggles.slice(1).forEach(item => item.remove())
        const keepToggle = toggles[0] || null
        const keepCard = cards[0] || null
        cleanup115LocalSyncUi(keepCard, keepToggle)
        if (cards[0] && toggles[0]) {
            // 兼容已经在页面中运行的旧版本：旧版本会在展开后把按钮隐藏，且按钮本身没有收起逻辑。
            const toggle = toggles[0]
            const card = cards[0]
            toggle.classList.remove('hidden')
            toggle.setAttribute('aria-expanded', String(!card.classList.contains('hidden')))
            if (toggle.dataset.missavToggleGuard !== '1') {
                toggle.addEventListener('click', event => {
                    event.preventDefault()
                    event.stopImmediatePropagation()
                    if (toggle.dataset.dragMoved === '1') return
                    const open = card.classList.contains('hidden')
                    card.classList.toggle('hidden', !open)
                    toggle.setAttribute('aria-expanded', String(open))
                }, true)
                toggle.dataset.missavToggleGuard = '1'
            }
            return
        }
        cards.forEach(item => item.remove())
        toggles.forEach(item => item.remove())
        create115LocalSyncElement(localSyncState)
    }

    function schedule115LocalSyncEnsure() {
        if (localSyncEnsureTimer) return
        localSyncEnsureTimer = setTimeout(() => {
            localSyncEnsureTimer = null
            ensure115LocalSyncCard()
        }, 0)
    }

    function install115LocalSyncLifecycle() {
        if (!is115UserPage() || !document.documentElement) return
        ensure115LocalSyncCard()
        if (localSyncEnsureObserver) return
        localSyncEnsureObserver = new MutationObserver(schedule115LocalSyncEnsure)
        localSyncEnsureObserver.observe(document.documentElement, { childList: true, subtree: true })
        window.addEventListener('popstate', schedule115LocalSyncEnsure)
        if (!localSyncEnsureInterval) {
            localSyncEnsureInterval = setInterval(() => ensure115LocalSyncCard(), 1200)
        }
    }

    function ensure115CloudStyles() {
        if (document.getElementById('missav-115-cloud-styles')) return
        const style = document.createElement('style')
        style.id = 'missav-115-cloud-styles'
        style.textContent = [
            '#missav-115-cloud-card{position:fixed;top:16px;left:16px;z-index:2147483645;width:310px;height:480px;min-width:260px;min-height:180px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);resize:both;overflow:auto;box-sizing:border-box;padding:12px;border:1px solid #f59e0b;border-radius:10px;background:linear-gradient(145deg,#251b0b,#171923);color:#f8fafc;font:13px/1.45 Arial,sans-serif;box-shadow:0 8px 26px rgba(0,0,0,.35);}',
            '.missav-115-cloud-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;}',
            '.missav-115-cloud-title{font-weight:800;color:#fde68a;}',
            '.missav-115-cloud-close{border:0;background:transparent;color:#cbd5e1;font-size:18px;line-height:1;cursor:pointer;padding:0 2px;}',
            '.missav-115-cloud-status{color:#cbd5e1;font-size:12px;}',
            '.missav-115-cloud-status.loading{color:#93c5fd;}',
            '.missav-115-cloud-status.found{color:#86efac;}',
            '.missav-115-cloud-status.empty{color:#fcd34d;}',
            '.missav-115-cloud-status.error{color:#fca5a5;}',
            '.missav-115-cloud-list{display:flex;flex-direction:column;gap:7px;margin-top:9px;max-height:360px;overflow:auto;}',
            '.missav-115-cloud-item{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid rgba(245,158,11,.35);border-radius:7px;background:rgba(15,23,42,.72);}',
            '.missav-115-cloud-file{min-width:0;flex:1;}',
            '.missav-115-cloud-name{color:#f8fafc;word-break:break-word;font-size:12px;}',
            '.missav-115-cloud-meta{margin-top:3px;color:#a5b4fc;font-size:10px;word-break:break-word;}',
            '.missav-115-cloud-download-error{padding:10px 0 2px;color:#fca5a5;font-size:12px;line-height:1.5;}',
            '.missav-115-cloud-actions{display:flex;flex:0 0 auto;gap:4px;align-items:center;}',
            '.missav-115-cloud-play,.missav-115-cloud-folder{min-height:28px;padding:0 8px;border:0;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;}',
            '.missav-115-cloud-play{background:#fbbf24;color:#1f2937;}',
            '.missav-115-cloud-folder{background:#60a5fa;color:#082f49;}',
            '.missav-115-cloud-play:hover,.missav-115-cloud-folder:hover{filter:brightness(1.08);}',
            '.missav-115-cloud-more{display:none;margin:8px auto 0;min-height:28px;padding:0 12px;border:1px solid #fbbf24;border-radius:5px;background:transparent;color:#fde68a;font-size:12px;cursor:pointer;}',
            '@media(max-width:560px){#missav-115-cloud-card{top:10px;left:10px;width:calc(100vw - 20px);}.missav-115-cloud-list{max-height:260px;}}'
        ].join('\n')
        document.head.appendChild(style)
    }

    const MISSAV_115_CARD_WIDTH_KEY = 'missav-115-cloud-card-width'
    const MISSAV_115_CARD_HEIGHT_KEY = 'missav-115-cloud-card-height-v2'
    const MISSAV_115_CARD_DEFAULT_WIDTH = 310
    const MISSAV_115_CARD_DEFAULT_HEIGHT = 480

    function read115CardSize(key, fallback, min, max) {
        let value
        try {
            value = typeof GM_getValue === 'function'
                ? GM_getValue(key, fallback)
                : localStorage.getItem(key)
        } catch (error) {
            value = fallback
        }
        const numeric = Number(value)
        return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.round(numeric))) : fallback
    }

    function save115CardSize(card) {
        if (!card) return
        const rect = card.getBoundingClientRect()
        const width = Math.round(rect.width)
        const height = Math.round(rect.height)
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(MISSAV_115_CARD_WIDTH_KEY, width)
                GM_setValue(MISSAV_115_CARD_HEIGHT_KEY, height)
            } else {
                localStorage.setItem(MISSAV_115_CARD_WIDTH_KEY, String(width))
                localStorage.setItem(MISSAV_115_CARD_HEIGHT_KEY, String(height))
            }
        } catch (error) {
            // 某些脚本管理器禁用存储时，卡片仍应保持可用。
        }
    }

    function restore115CardSize(card) {
        if (!card) return
        const width = read115CardSize(MISSAV_115_CARD_WIDTH_KEY, MISSAV_115_CARD_DEFAULT_WIDTH, 260, 900)
        const height = read115CardSize(MISSAV_115_CARD_HEIGHT_KEY, MISSAV_115_CARD_DEFAULT_HEIGHT, 180, 900)
        card.style.width = width + 'px'
        card.style.height = height + 'px'

        let saveTimer = null
        const scheduleSave = () => {
            clearTimeout(saveTimer)
            saveTimer = setTimeout(() => save115CardSize(card), 250)
        }
        if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(scheduleSave)
            observer.observe(card)
            card._missav115ResizeObserver = observer
        } else {
            card.addEventListener('mouseup', scheduleSave)
            card.addEventListener('touchend', scheduleSave)
        }
    }

    function get115CloudDownloadArea(card) {
        return card && card.querySelector('.missav-115-cloud-download')
    }

    function attachVideoDownloadTo115Card(card, fileInfo) {
        const area = get115CloudDownloadArea(card)
        if (!area) return false
        area.replaceChildren(createUrlElement(fileInfo))
        return true
    }

    function showVideoDownloadErrorOn115Card(card, error) {
        const area = get115CloudDownloadArea(card)
        if (!area) return false
        const errorTip = document.createElement('div')
        errorTip.className = 'missav-115-cloud-download-error'
        errorTip.textContent = '最高分辨率视频列表获取失败：' + ((error && error.message) || error || '未知错误')
        area.replaceChildren(errorTip)
        return true
    }

    function create115CloudSearchElement(code) {
        const keys = get115SearchKeywords(code)
        ensure115CloudStyles()
        const card = document.createElement('section')
        card.id = 'missav-115-cloud-card'
        const head = document.createElement('div')
        head.className = 'missav-115-cloud-head'
        const title = document.createElement('div')
        title.className = 'missav-115-cloud-title'
        title.textContent = '115 · ' + (keys.display || '未识别番号')
        head.appendChild(title)
        const close = document.createElement('button')
        close.className = 'missav-115-cloud-close'
        close.type = 'button'
        close.textContent = '×'
        close.title = '关闭提示'
        close.addEventListener('click', () => card.remove())
        head.appendChild(close)
        card.appendChild(head)

        const status = document.createElement('div')
        status.className = 'missav-115-cloud-status loading'
        status.textContent = keys.exact ? '正在查询 ' + keys.exact + '…' : '等待有效番号…'
        card.appendChild(status)
        const list = document.createElement('div')
        list.className = 'missav-115-cloud-list'
        card.appendChild(list)

        const more = document.createElement('button')
        more.className = 'missav-115-cloud-more'
        more.type = 'button'
        more.textContent = '加载更多'
        card.appendChild(more)

        const downloadArea = document.createElement('div')
        downloadArea.className = 'missav-115-cloud-download'
        card.appendChild(downloadArea)
        document.body.appendChild(card)
        restore115CardSize(card)

        if (!keys.exact) {
            status.className = 'missav-115-cloud-status empty'
            status.textContent = '未查询：当前页面没有识别到有效番号'
            return card
        }

        let expanded = false
        search115CloudByPriority(keys, () => {
            status.textContent = '精确番号无结果，正在查询 ' + keys.fallback + '…'
        }).then(result => {
            const items = result.items
            const keyword = result.keyword
            list.replaceChildren()
            if (!items.length) {
                status.className = 'missav-115-cloud-status empty'
                status.textContent = '未找到「' + keys.display + '」'
                more.style.display = 'none'
                return
            }
            status.className = 'missav-115-cloud-status found'
            status.textContent = '已找到 ' + items.length + ' 个'
            const renderItems = () => {
                list.replaceChildren()
                const visibleItems = expanded ? items : items.slice(0, 3)
                visibleItems.forEach(item => {
                    const row = document.createElement('div')
                    row.className = 'missav-115-cloud-item'
                    const info = document.createElement('div')
                    info.className = 'missav-115-cloud-file'
                    const name = document.createElement('div')
                    name.className = 'missav-115-cloud-name'
                    name.textContent = item.name
                    name.title = item.name
                    info.appendChild(name)
                    const meta = document.createElement('div')
                    meta.className = 'missav-115-cloud-meta'
                    meta.textContent = format115FileSize(item.sizeBytes) + (item.path ? ' · ' + item.path : '')
                    info.appendChild(meta)
                    row.appendChild(info)
                    const actions = document.createElement('div')
                    actions.className = 'missav-115-cloud-actions'
                    const play = document.createElement('button')
                    play.className = 'missav-115-cloud-play'
                    play.type = 'button'
                    play.textContent = '播放'
                    play.addEventListener('click', () => open115VideoFile(item, keyword))
                    actions.appendChild(play)
                    const folder = document.createElement('button')
                    folder.className = 'missav-115-cloud-folder'
                    folder.type = 'button'
                    folder.textContent = '文件夹'
                    folder.title = item.parentCid ? '打开视频所在文件夹' : '未返回目录编号，将打开 115 搜索页'
                    folder.addEventListener('click', () => open115ParentFolder(item, keyword))
                    actions.appendChild(folder)
                    row.appendChild(actions)
                    list.appendChild(row)
                })
                if (items.length > 3) {
                    more.style.display = 'inline-flex'
                    more.textContent = expanded ? '收起' : '加载更多'
                } else {
                    more.style.display = 'none'
                }
            }
            more.onclick = () => {
                expanded = !expanded
                renderItems()
            }
            renderItems()
        }).catch(error => {
            list.replaceChildren()
            more.style.display = 'none'
            const type = error && error.type
            status.className = 'missav-115-cloud-status error'
            status.textContent = type === 'auth'
                ? '未查询：当前浏览器未登录 115，或登录状态已失效'
                : type === 'unsupported'
                    ? '查询失败：脚本缺少跨域请求权限'
                    : '查询失败：' + ((error && error.message) || '115 接口暂时不可用')
        })
        return card
    }

    function generateSafeFileName(selector) {
        let elements = document.querySelectorAll(selector)
        let combinedText = Array.from(elements)
            .map(element => element.textContent.trim())
            .join(' ')

        // 移除无效字符，确保文件名安全
        let safeFileName = combinedText.replace(/[\\/:*?"<>|]/g, '').substring(0, 100) // 限制文件名长度为100字符
        return safeFileName
    }
    function decodePackedString(value) {
        return String(value || '')
            .replace(/\\(['\\])/g, '$1')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
    }

    // 解压页面常见的 Dean Edwards packed eval，只做字符串替换，不执行页面代码。
    function decodePackedPlayerScripts(text) {
        const decoded = []
        const packedRe = /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\(\s*'((?:\\.|[^'])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'])*)'\.split\('\|'\)/g
        let match
        while ((match = packedRe.exec(String(text || '')))) {
            let source = decodePackedString(match[1])
            const count = Number(match[3])
            const dictionary = decodePackedString(match[4]).split('|')
            for (let index = count - 1; index >= 0; index--) {
                const word = dictionary[index]
                if (!word) continue
                source = source.replace(new RegExp('\\b' + index.toString(36) + '\\b', 'g'), word)
            }
            decoded.push(source)
        }
        return decoded
    }

    // 按播放器源提取视频 UUID，不再从整页广告 iframe 中盲取第一个 UUID。
    function extractVideoUuid() {
        const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
        const uuidGlobalRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
        const scripts = Array.from(document.querySelectorAll('script'))
        const mediaTexts = []
        const addMediaText = value => {
            const text = String(value || '')
            if (!text || !/(?:surrit|m3u8|playlist|source\d{3,4})/i.test(text)) return
            mediaTexts.push(text)
            decodePackedPlayerScripts(text).forEach(decoded => mediaTexts.push(decoded))
        }
        scripts.forEach(script => addMediaText(script.textContent || ''))

        // 页面播放器已经初始化时，直接读取其实际源，优先级最高。
        const runtimeSources = [
            typeof unsafeWindow !== 'undefined' && unsafeWindow.hls && unsafeWindow.hls.url,
            typeof unsafeWindow !== 'undefined' && unsafeWindow.player && unsafeWindow.player.source,
            document.querySelector('video') && document.querySelector('video').src
        ]
        runtimeSources.forEach(addMediaText)

        for (const text of mediaTexts) {
            const direct = text.match(/https?:\/\/[^\s'"\\]+/i)
            if (direct && /(?:surrit|m3u8|playlist)/i.test(direct[0])) {
                const match = direct[0].match(uuidRe)
                if (match) return match[0]
            }
            const matches = text.match(uuidGlobalRe)
            if (matches && matches.length) return matches[matches.length - 1]
        }
        return null
    }
    function parseM3u8Attributes(line) {
        const attrs = {}
        const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi
        let match
        while ((match = re.exec(line))) {
            attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '')
        }
        return attrs
    }

    function qualityFromText(text) {
        const value = String(text || '')
        if (/\b4K\b/i.test(value)) return 2160
        const match = value.match(/\b(4320|2160|1440|1080|900|720|576|540|480|360|240)\s*P?\b/i)
        return match ? Number(match[1]) : 0
    }

    function resolvePlaylistUrl(rawUrl, baseUrl) {
        try {
            return new URL(rawUrl, baseUrl).href
        } catch (error) {
            return null
        }
    }

    function parseM3u8ByteRange(value, fallbackStart) {
        const match = String(value || '').replace(/^"|"$/g, '').match(/^(\d+)(?:@(\d+))?$/)
        if (!match) return null
        const length = Number(match[1])
        const start = match[2] === undefined ? Number(fallbackStart || 0) : Number(match[2])
        if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(start) || start < 0) return null
        return { start: start, end: start + length - 1 }
    }

    function stableVideoSegmentUrl(url) {
        try {
            const parsed = new URL(url)
            return parsed.origin + parsed.pathname
        } catch (error) {
            return String(url || '').split('?')[0]
        }
    }

    function hashVideoText(value) {
        let hash = 2166136261
        for (let i = 0; i < value.length; i++) {
            hash ^= value.charCodeAt(i)
            hash = Math.imul(hash, 16777619)
        }
        return (hash >>> 0).toString(16)
    }

    function videoSegmentSignature(segments) {
        const text = (segments || []).map(segment => [
            stableVideoSegmentUrl(segment.url),
            Number.isFinite(segment.rangeStart) ? segment.rangeStart : '',
            Number.isFinite(segment.rangeEnd) ? segment.rangeEnd : ''
        ].join('|')).join('\n')
        return hashVideoText(text)
    }

    function parseM3u8Variants(text, baseUrl) {
        const lines = String(text || '').split(/\r?\n/)
        const variants = []
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim()
            if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
            const attrs = parseM3u8Attributes(line.substring('#EXT-X-STREAM-INF:'.length))
            let rawUrl = ''
            for (let j = i + 1; j < lines.length; j++) {
                const candidate = lines[j].trim()
                if (candidate && !candidate.startsWith('#')) {
                    rawUrl = candidate
                    break
                }
            }
            const playlistUrl = resolvePlaylistUrl(rawUrl, baseUrl)
            if (!playlistUrl) continue
            const resolution = (attrs.RESOLUTION || '').match(/(\d+)\s*x\s*(\d+)/i)
            const width = resolution ? Number(resolution[1]) : 0
            const height = resolution ? Number(resolution[2]) : qualityFromText(rawUrl)
            variants.push({
                url: playlistUrl,
                width: width,
                height: height,
                bandwidth: Number(attrs.BANDWIDTH || 0),
                display: height ? height + 'p' : '未知清晰度'
            })
        }
        if (variants.length) return variants

        // 兼容原脚本使用的“360p/playlist.m3u8”这类无 EXT-X-STREAM-INF 的主列表。
        return lines
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#') && /\.m3u8(?:[?#].*)?$/i.test(line))
            .map(rawUrl => {
                const playlistUrl = resolvePlaylistUrl(rawUrl, baseUrl)
                const height = qualityFromText(rawUrl)
                return playlistUrl ? {
                    url: playlistUrl,
                    width: 0,
                    height: height,
                    bandwidth: 0,
                    display: height ? height + 'p' : rawUrl.split('/')[0]
                } : null
            })
            .filter(Boolean)
    }

    function selectBestM3u8Variant(variants) {
        return variants.slice().sort((a, b) => {
            return (b.height - a.height) ||
                (b.width - a.width) ||
                (b.bandwidth - a.bandwidth)
        })[0]
    }

    function parseM3u8Segments(text, baseUrl) {
        const segments = []
        let pendingByteRange = null
        let pendingDiscontinuity = false
        let lastMapKey = ''
        const lastRangeEndByUrl = new Map()
        String(text || '').split(/\r?\n/).forEach(line => {
            const trimmed = line.trim()
            if (!trimmed) return
            if (trimmed.startsWith('#EXT-X-MAP:')) {
                const attrs = parseM3u8Attributes(trimmed.substring('#EXT-X-MAP:'.length))
                const initUrl = resolvePlaylistUrl(attrs.URI, baseUrl)
                if (initUrl) {
                    const range = attrs.BYTERANGE
                        ? parseM3u8ByteRange(attrs.BYTERANGE, lastRangeEndByUrl.get(initUrl) || 0)
                        : null
                    const mapKey = initUrl + '|' + (range ? range.start + '-' + range.end : '')
                    if (mapKey !== lastMapKey) {
                        segments.push({
                            index: segments.length,
                            url: initUrl,
                            rangeStart: range ? range.start : undefined,
                            rangeEnd: range ? range.end : undefined
                        })
                        lastMapKey = mapKey
                    }
                    if (range) lastRangeEndByUrl.set(initUrl, range.end + 1)
                }
                return
            }
            if (trimmed.startsWith('#EXT-X-BYTERANGE:')) {
                pendingByteRange = trimmed.substring('#EXT-X-BYTERANGE:'.length).trim()
                return
            }
            if (trimmed.startsWith('#EXT-X-DISCONTINUITY')) {
                pendingDiscontinuity = true
                return
            }
            if (trimmed.startsWith('#')) return
            const segmentUrl = resolvePlaylistUrl(trimmed, baseUrl)
            if (!segmentUrl) return
            const range = pendingByteRange
                ? parseM3u8ByteRange(pendingByteRange, lastRangeEndByUrl.get(segmentUrl) || 0)
                : null
            segments.push({
                index: segments.length,
                url: segmentUrl,
                rangeStart: range ? range.start : undefined,
                rangeEnd: range ? range.end : undefined,
                discontinuityBefore: pendingDiscontinuity
            })
            if (range) lastRangeEndByUrl.set(segmentUrl, range.end + 1)
            pendingByteRange = null
            pendingDiscontinuity = false
        })
        return segments
    }

    async function loadBestVideoInfo(masterUrl, filename) {
        const masterText = await fetchVideoList(masterUrl)
        const variants = parseM3u8Variants(masterText, masterUrl)
        const best = selectBestM3u8Variant(variants)
        const playlistUrl = best ? best.url : masterUrl
        const playlistText = best ? await fetchVideoList(playlistUrl) : masterText
        const segments = parseM3u8Segments(playlistText, playlistUrl)
        if (!segments.length) throw new Error('最高分辨率播放列表没有找到视频分片')
        const segmentSignature = videoSegmentSignature(segments)
        return {
            filename: filename,
            display: best ? best.display : '最高分辨率',
            url: playlistUrl,
            segments: segments,
            container: /#EXT-X-MAP:/i.test(playlistText) ? 'mp4' : 'ts',
            segmentSignature: segmentSignature,
            hasDiscontinuity: segments.some(segment => segment.discontinuityBefore),
            // 同一番号的播放列表发生变化时使用新的缓存键，避免把旧分片套到新时间轴上。
            jobId: videoJobId(masterUrl, filename, segmentSignature)
        }
    }

    // 从页面 URL 的 slug 提取番号，用于磁力搜索
    function extractCode() {
        const seg = (location.pathname.split('/').filter(Boolean).pop() || '')
        let m = seg.match(/fc2-?(ppv-?)?\d{5,}/i)
        if (m) return m[0].toUpperCase().replace(/_/g, '-')
        m = seg.match(/\d*[a-z]+\d*-\d+/i)
        if (m) return m[0].toUpperCase()
        return seg.toUpperCase()
    }
    // 生成「按番号去各磁力站搜现成磁力」的旧入口，保留作兼容参考。
    function legacyCreateMagnetSearchElement(code) {
        const sites = [
            { name: 'Sukebei', url: 'https://sukebei.nyaa.si/?f=0&c=0_0&q=' + encodeURIComponent(code) },
            { name: 'TorrentKitty', url: 'https://www.torrentkitty.tv/search/' + encodeURIComponent(code) },
            { name: 'JavBus', url: 'https://www.javbus.com/search/' + encodeURIComponent(code) },
            { name: 'BTDIG', url: 'https://btdig.com/search?q=' + encodeURIComponent(code) }
        ]
        const wrap = document.createElement('div')
        wrap.style.cssText = 'width:100%; padding:8px 5px; margin-bottom:6px; border:1px solid deepskyblue; border-radius:6px;'
        const label = document.createElement('div')
        label.style.cssText = 'color:white; font-size:13px; margin-bottom:6px;'
        label.textContent = '番号 ' + code + ' — 去这些站搜现成磁力，复制丢 115 离线（115 缓存命中常常秒存）：'
        wrap.appendChild(label)
        const row = document.createElement('div')
        row.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px; align-items:center;'
        sites.forEach(s => {
            const a = document.createElement('a')
            a.href = s.url
            a.target = '_blank'
            a.rel = 'noopener'
            a.textContent = '🔍 ' + s.name
            a.style.cssText = 'background-color:deepskyblue; color:black; font-weight:bold; padding:4px 10px; border-radius:4px; text-decoration:none;'
            row.appendChild(a)
        })
        const copy = document.createElement('button')
        copy.textContent = '复制番号'
        copy.style.cssText = 'background-color:lightgray; color:black; padding:4px 10px; border-radius:4px;'
        copy.addEventListener('click', () => {
            navigator.clipboard.writeText(code).then(() => alert('已复制番号：' + code))
        })
        row.appendChild(copy)
        wrap.appendChild(row)
        return wrap
    }
    function requestMagnetPage(url, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('脚本缺少 GM_xmlhttpRequest 权限'))
                return
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: timeoutMs || 12000,
                headers: { Accept: 'text/html,application/xhtml+xml' },
                onload: response => {
                    if (response.status >= 200 && response.status < 400) {
                        resolve(response.responseText || '')
                    } else {
                        reject(new Error('HTTP ' + response.status))
                    }
                },
                ontimeout: () => reject(new Error('请求超时')),
                onerror: () => reject(new Error('请求失败'))
            })
        })
    }

    function decodeHtmlText(value) {
        const textarea = document.createElement('textarea')
        textarea.innerHTML = String(value || '')
        return textarea.value
    }

    function stripHtmlText(value) {
        return decodeHtmlText(String(value || '')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' '))
            .replace(/\s+/g, ' ')
            .trim()
    }

    function parseMagnetSize(text) {
        const match = String(text || '').match(/(\d+(?:[.,]\d+)?)\s*(TB|TIB|GB|GIB|MB|MIB|KB|KIB|B)\b/i)
        if (!match) return 0
        const unit = match[2].toUpperCase()
        const value = Number(match[1].replace(',', '.'))
        const factor = {
            B: 1,
            KB: 1000,
            KIB: 1024,
            MB: 1000 * 1000,
            MIB: 1024 * 1024,
            GB: 1000 * 1000 * 1000,
            GIB: 1024 * 1024 * 1024,
            TB: 1000 * 1000 * 1000 * 1000,
            TIB: 1024 * 1024 * 1024 * 1024
        }
        return value * (factor[unit] || 0)
    }

    function magnetContext(html, index) {
        const rowStart = html.lastIndexOf('<tr', index)
        const rowEnd = html.indexOf('</tr>', index)
        if (rowStart >= 0 && rowEnd > rowStart) {
            return html.slice(rowStart, rowEnd + 5)
        }
        const listStart = html.lastIndexOf('<li', index)
        const listEnd = html.indexOf('</li>', index)
        if (listStart >= 0 && listEnd > listStart) {
            return html.slice(listStart, listEnd + 5)
        }
        return html.slice(Math.max(0, index - 1800), Math.min(html.length, index + 1200))
    }

    function parseMagnetResults(html, sourceName) {
        const results = []
        const magnetRe = /<a\b[^>]*href\s*=\s*["'](magnet:\?[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
        let match
        while ((match = magnetRe.exec(html))) {
            const magnet = decodeHtmlText(match[1]).replace(/\s+/g, '')
            if (!magnet || results.some(item => item.magnet === magnet)) continue
            const context = magnetContext(html, match.index)
            const links = []
            const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
            let linkMatch
            while ((linkMatch = linkRe.exec(context))) {
                const href = decodeHtmlText(linkMatch[1])
                const label = stripHtmlText(linkMatch[2])
                if (!/^magnet:/i.test(href) && label && !/^magnet$/i.test(label) && !/^复制$/i.test(label)) {
                    links.push({ href: href, label: label })
                }
            }
            const text = stripHtmlText(context)
            const titleLink = links.find(item => /\/(?:view|torrent|detail)\//i.test(item.href)) ||
                links.find(item => item.label.length > 20) ||
                links[0]
            const title = (titleLink && titleLink.label) || text || sourceName + ' 磁力'
            results.push({
                source: sourceName,
                name: title.substring(0, 180),
                magnet: magnet,
                sizeBytes: parseMagnetSize(text),
                sizeLabel: (text.match(/(\d+(?:[.,]\d+)?)\s*(TB|TIB|GB|GIB|MB|MIB|KB|KIB)\b/i) || [])[0] || '容量未知',
                quality: qualityFromText(title),
                detailUrl: titleLink ? titleLink.href : ''
            })
        }
        return results
    }

    function extractMagnetDetailLinks(html, baseUrl) {
        const links = []
        const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
        let match
        while ((match = linkRe.exec(html))) {
            const href = decodeHtmlText(match[1])
            const label = stripHtmlText(match[2])
            if (!label || /^magnet:/i.test(href)) continue
            if (!/(\/view\/|\/torrent\/|\/detail\/|\/download\/)/i.test(href)) continue
            try {
                const absolute = new URL(href, baseUrl).href
                if (!links.some(item => item.url === absolute)) {
                    links.push({ url: absolute, label: label })
                }
            } catch (error) {}
        }
        return links.slice(0, 4)
    }

    async function searchMagnetSource(source, options) {
        const settings = options || {}
        const html = await requestMagnetPage(source.url, settings.timeoutMs)
        let results = parseMagnetResults(html, source.name)
        if (settings.expandDetails !== false && results.length < 3) {
            const detailLinks = extractMagnetDetailLinks(html, source.url)
            const detailResults = await Promise.all(detailLinks.map(async link => {
                try {
                    const detailHtml = await requestMagnetPage(link.url, settings.timeoutMs)
                    return parseMagnetResults(detailHtml, source.name).map(item => {
                        item.name = link.label || item.name
                        item.detailUrl = link.url
                        return item
                    })
                } catch (error) {
                    return []
                }
            }))
            results = results.concat(detailResults.flat())
        }
        return results
    }

    function rankMagnetResults(groups) {
        const all = []
        groups.forEach(group => {
            group.forEach(item => {
                if (!all.some(existing => existing.magnet === item.magnet)) all.push(item)
            })
        })
        return all.sort((a, b) => {
            const aPreferred = /(破解|reducing[\s._-]*mosaic)/i.test(a.name) ? 1 : 0
            const bPreferred = /(破解|reducing[\s._-]*mosaic)/i.test(b.name) ? 1 : 0
            return (bPreferred - aPreferred) ||
                ((b.sizeBytes || 0) - (a.sizeBytes || 0)) ||
                ((b.quality || 0) - (a.quality || 0))
        })
    }

    function chooseMagnetResults(groups, limit) {
        return rankMagnetResults(groups).slice(0, limit || 3)
    }

    function ensureMagnetStyles() {
        if (document.getElementById('missav-magnet-styles')) return
        const style = document.createElement('style')
        style.id = 'missav-magnet-styles'
        style.textContent = [
            '.missav-magnet-panel{width:100%;box-sizing:border-box;padding:12px;margin-bottom:10px;border:1px solid #22d3ee;border-radius:10px;background:linear-gradient(135deg,#111827,#172033);color:#e5eef7;font-family:Arial,sans-serif;}',
            '.missav-magnet-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px;}',
            '.missav-magnet-title{font-size:14px;font-weight:700;color:#f4fbff;}',
            '.missav-magnet-status{font-size:12px;color:#a9e8f1;min-height:18px;}',
            '.missav-magnet-manual{display:flex;flex-wrap:wrap;gap:6px;padding:9px 0;border-top:1px solid rgba(148,163,184,.22);border-bottom:1px solid rgba(148,163,184,.22);}',
            '.missav-magnet-link,.missav-magnet-copycode{display:inline-flex;align-items:center;justify-content:center;min-height:30px;padding:0 10px;border:0;border-radius:6px;background:#26364d;color:#e8f7ff;font-size:12px;font-weight:600;text-decoration:none;cursor:pointer;}',
            '.missav-magnet-link:hover,.missav-magnet-copycode:hover{background:#0ea5e9;color:#07111f;}',
            '.missav-magnet-results{display:grid;grid-template-columns:repeat(auto-fit,minmax(275px,1fr));gap:9px;margin-top:10px;}',
            '.missav-magnet-card{min-width:0;display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid #35516b;border-radius:8px;background:#1c2738;box-shadow:0 3px 10px rgba(0,0,0,.18);}',
            '.missav-magnet-card-top{display:flex;align-items:flex-start;gap:7px;min-width:0;}',
            '.missav-magnet-rank{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#0ea5e9;color:#07111f;font-weight:800;font-size:12px;}',
            '.missav-magnet-card-title{min-width:0;color:#f8fbff;font-size:12px;line-height:1.45;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}',
            '.missav-magnet-meta{display:flex;flex-wrap:wrap;gap:6px;color:#9fd7df;font-size:11px;}',
            '.missav-magnet-tag{padding:2px 5px;border-radius:4px;background:#29445a;color:#c9f5ff;}',
            '.missav-magnet-tag.preferred{background:#71451b;color:#ffe4ad;}',
            '.missav-magnet-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;}',
            '.missav-magnet-action{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:0 9px;border:0;border-radius:5px;background:#dbeafe;color:#0b2239;font-size:12px;font-weight:700;text-decoration:none;cursor:pointer;}',
            '.missav-magnet-action:hover{filter:brightness(1.08);}',
            '.missav-magnet-more{display:none;margin:10px auto 0;min-height:30px;padding:0 16px;border:1px solid #38bdf8;border-radius:6px;background:transparent;color:#bdefff;font-size:12px;cursor:pointer;}',
            '@media (max-width:560px){.missav-magnet-head{align-items:flex-start;flex-direction:column;}.missav-magnet-results{grid-template-columns:1fr;}.missav-magnet-link,.missav-magnet-copycode{flex:1 1 auto;}}'
        ].join('\n')
        document.head.appendChild(style)
    }

    function createMagnetCard(item, rank) {
        const card = document.createElement('div')
        card.className = 'missav-magnet-card'

        const top = document.createElement('div')
        top.className = 'missav-magnet-card-top'
        const rankBadge = document.createElement('span')
        rankBadge.className = 'missav-magnet-rank'
        rankBadge.textContent = String(rank)
        top.appendChild(rankBadge)
        const name = document.createElement('div')
        name.className = 'missav-magnet-card-title'
        name.textContent = item.name
        name.title = item.magnet
        top.appendChild(name)
        card.appendChild(top)

        const meta = document.createElement('div')
        meta.className = 'missav-magnet-meta'
        const sourceTag = document.createElement('span')
        sourceTag.className = 'missav-magnet-tag'
        sourceTag.textContent = item.source
        meta.appendChild(sourceTag)
        const sizeTag = document.createElement('span')
        sizeTag.className = 'missav-magnet-tag'
        sizeTag.textContent = item.sizeLabel
        meta.appendChild(sizeTag)
        if (/(破解|reducing[\s._-]*mosaic)/i.test(item.name)) {
            const preferredTag = document.createElement('span')
            preferredTag.className = 'missav-magnet-tag preferred'
            preferredTag.textContent = '优先词'
            meta.appendChild(preferredTag)
        }
        card.appendChild(meta)

        const actions = document.createElement('div')
        actions.className = 'missav-magnet-actions'
        const copy = document.createElement('button')
        copy.className = 'missav-magnet-action'
        copy.textContent = '复制磁力'
        copy.addEventListener('click', () => {
            navigator.clipboard.writeText(item.magnet).then(() => {
                copy.textContent = '已复制'
                setTimeout(() => { copy.textContent = '复制磁力' }, 1500)
            }).catch(error => {
                console.error('[磁力搜索] 复制失败', error)
                alert('复制失败，请检查浏览器剪贴板权限')
            })
        })
        actions.appendChild(copy)

        const to115 = document.createElement('button')
        to115.className = 'missav-magnet-action'
        to115.textContent = '转存115'
        to115.addEventListener('click', () => submitTo115(item.magnet, to115))
        actions.appendChild(to115)
        card.appendChild(actions)
        return card
    }

    // 先搜索 Sukebei、BTDIG；两站都没有结果时，再自动扩展到其余站点。
    function createMagnetSearchElement(code) {
        ensureMagnetStyles()
        const sites = [
            { name: 'Sukebei', url: 'https://sukebei.nyaa.si/?f=0&c=0_0&q=' + encodeURIComponent(code) },
            { name: 'TorrentKitty', url: 'https://www.torrentkitty.tv/search/' + encodeURIComponent(code) },
            { name: 'JavBus', url: 'https://www.javbus.com/search/' + encodeURIComponent(code) },
            { name: 'BTDIG', url: 'https://btdig.com/search?q=' + encodeURIComponent(code) },
            { name: 'Nyaa', url: 'https://nyaa.si/?f=0&c=0_0&q=' + encodeURIComponent(code) },
            { name: 'Tokyo Toshokan', url: 'https://www.tokyotosho.info/search.php?terms=' + encodeURIComponent(code) + '&type=0' }
        ]
        const autoSites = [sites[0], sites[3]]
        const fallbackSites = sites.filter(site => !autoSites.includes(site))
        const wrap = document.createElement('div')
        wrap.id = 'missav-magnet-panel'
        wrap.className = 'missav-magnet-panel'

        const head = document.createElement('div')
        head.className = 'missav-magnet-head'
        const title = document.createElement('div')
        title.className = 'missav-magnet-title'
        title.textContent = '番号 ' + code + ' · 现成磁力'
        head.appendChild(title)
        const rule = document.createElement('div')
        rule.className = 'missav-magnet-status'
        rule.textContent = '优先“破解 / Reducing Mosaic”，其次按单个文件容量排序'
        head.appendChild(rule)
        wrap.appendChild(head)

        const status = document.createElement('div')
        status.className = 'missav-magnet-status'
        status.textContent = '首轮搜索中：Sukebei、BTDIG；若无结果将自动搜索其他站点'
        wrap.appendChild(status)

        const manualLabel = document.createElement('div')
        manualLabel.textContent = '手动搜索入口'
        manualLabel.style.cssText = 'margin-top:8px;color:#8fb8c5;font-size:11px;'
        wrap.appendChild(manualLabel)
        const manualRow = document.createElement('div')
        manualRow.className = 'missav-magnet-manual'
        sites.forEach(site => {
            const link = document.createElement('a')
            link.className = 'missav-magnet-link'
            link.href = site.url
            link.target = '_blank'
            link.rel = 'noopener'
            link.textContent = '🔍 ' + site.name
            manualRow.appendChild(link)
        })
        const copyCode = document.createElement('button')
        copyCode.className = 'missav-magnet-copycode'
        copyCode.textContent = '复制番号'
        copyCode.addEventListener('click', () => {
            navigator.clipboard.writeText(code).then(() => {
                copyCode.textContent = '已复制番号'
                setTimeout(() => { copyCode.textContent = '复制番号' }, 1500)
            })
        })
        manualRow.appendChild(copyCode)
        wrap.appendChild(manualRow)

        const cards = document.createElement('div')
        cards.className = 'missav-magnet-results'
        wrap.appendChild(cards)
        const more = document.createElement('button')
        more.className = 'missav-magnet-more'
        more.textContent = '加载更多'
        wrap.appendChild(more)

        const allResults = []
        const sourceState = {}
        let visibleLimit = 3
        let finishedSources = 0
        let fallbackStarted = false

        const renderResults = () => {
            const ranked = rankMagnetResults([allResults])
            cards.replaceChildren()
            ranked.slice(0, visibleLimit).forEach((item, index) => {
                cards.appendChild(createMagnetCard(item, index + 1))
            })
            if (ranked.length > visibleLimit) {
                more.style.display = 'inline-flex'
                more.textContent = '加载更多（还剩 ' + (ranked.length - visibleLimit) + ' 条）'
            } else {
                more.style.display = 'none'
            }
            const sourceText = sites.map(site => site.name + '：' + (sourceState[site.name] || '待启动')).join(' · ')
            status.textContent = (fallbackStarted ? '扩展自动搜索' : '首轮自动搜索') + ' · ' + sourceText +
                (ranked.length ? ' · 当前 ' + ranked.length + ' 条候选' : '')
            if (fallbackStarted && finishedSources === fallbackSites.length && !ranked.length) {
                status.textContent = '自动扩展搜索也未解析到磁力，请使用下方手动入口；站点反爬或超时不影响手动搜索。'
            }
        }

        more.addEventListener('click', () => {
            visibleLimit += 3
            renderResults()
        })

        const startSearch = (sourceList) => {
            if (sourceList === fallbackSites) fallbackStarted = true
            finishedSources = 0
            sourceList.forEach(site => {
                sourceState[site.name] = '搜索中'
                searchMagnetSource(site, { expandDetails: sourceList === fallbackSites, timeoutMs: 8000 }).then(items => {
                    items.forEach(item => {
                        if (!allResults.some(existing => existing.magnet === item.magnet)) {
                            allResults.push(item)
                        }
                    })
                    sourceState[site.name] = '已返回 ' + items.length + ' 条'
                    finishedSources += 1
                    if (sourceList === autoSites && finishedSources === autoSites.length && !allResults.length && !fallbackStarted) {
                        startSearch(fallbackSites)
                    } else {
                        renderResults()
                    }
                }).catch(error => {
                    sourceState[site.name] = '失败'
                    finishedSources += 1
                    console.warn('[磁力搜索] ' + site.name + '：', error)
                    if (sourceList === autoSites && finishedSources === autoSites.length && !allResults.length && !fallbackStarted) {
                        startSearch(fallbackSites)
                    } else {
                        renderResults()
                    }
                })
            })
            renderResults()
        }

        startSearch(autoSites)
        return wrap
    }

    window.addEventListener('load', () => {
        const tools = document.querySelector('.order-first .mt-4') || document.querySelector('.order-first')
        if (!tools) {
            console.warn('[MissAV 下载] 未找到工具栏容器 (.order-first .mt-4)，页面结构可能已变化。')
            return
        }
        const h1 = document.querySelector('.order-first .mt-4 h1') || document.querySelector('h1')
        const filename = (h1 && h1.textContent.trim()) || 'missav_video'
        const flexDiv = document.createElement('div')
        flexDiv.className = 'flex justify-center space-x-4 md:space-x-6 py-8 rounded-md shadow-sm'
        flexDiv.style.flexDirection = 'column'
        flexDiv.style.alignItems = 'baseline'
        // 原脚本会移除工具栏内自带的占位块；做存在性保护，结构变化时不抛错中断
        if (tools.children.length > 1) {
            tools.removeChild(tools.children[1])
        }
        tools.appendChild(flexDiv)

        // 番号磁力搜索入口（不依赖视频地址，m3u8 抓取失败也能用）
        const code = extractCode()
        // 进入页面后自动查询当前浏览器登录的 115 网盘；结果卡片固定显示在左上角。
        const cloudCard = create115CloudSearchElement(code)
        flexDiv.appendChild(createMagnetSearchElement(code))

        const uuid = extractVideoUuid()
        if (!uuid) {
            console.warn('[MissAV 下载] 未能从页面中提取视频 UUID，无法生成下载链接。')
            return
        }
        const prefix = 'https://surrit.com/'
        const suffix = '/playlist.m3u8'
        const url = prefix + uuid + suffix
        console.log('[MissAV 下载] m3u8 地址:', url)
        loadBestVideoInfo(url, filename).then(fileInfo => {
            attachVideoDownloadTo115Card(cloudCard, fileInfo)
        }).catch(err => {
            console.error('[MissAV 下载] 获取 m3u8 失败:', err)
            showVideoDownloadErrorOn115Card(cloudCard, err)
        })
    })
    if (is115UserPage()) {
        install115ParentRenameSync()
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', install115LocalSyncLifecycle, { once: true })
        } else {
            setTimeout(install115LocalSyncLifecycle, 0)
        }
    }
    setTimeout(handle115OfflineHandoff, 0)
})();

// ===== 字幕搜索助手 =====
(function() {
    'use strict';

    // ==================== 全局配置常量 ====================
    const CONFIG = {
        CACHE_KEY: 'av_subtitle_cache',
        CACHE_VERSION: 3,
        CACHE_EXPIRATION_DAYS: 30,
        SEARCH_CACHE_KEY: 'av_subtitle_search_cache_v1',
        SEARCH_CACHE_TTL: 7 * 24 * 60 * 60 * 1000,
        SEARCH_CACHE_MAX_ENTRIES: 20,
        CHINESE_ONLY_KEY: 'av_subtitle_chinese_only_v1',
        SUBTITLE_PREFERENCE_KEY: 'av_subtitle_last_selection_v1',
        API_REQUEST_DELAY: 1200,
        VIDEO_CARD_SELECTOR: '.card, .aspect-w-16, .video-item, [class*="video"], .movie-item, .video-card, .item, .video-card, [data-href*="/video/"]',
        DEFAULT_SPEED: 1.25
    };

    // ==================== 全局状态 ====================
    const state = {
        currentVideo: null,
        subtitleData: [],
        lastSubtitleIndex: -1,
        subtitleOffset: 0,
        subtitleEnabled: true,
        subtitleStyle: 'none',
        subtitleFontSize: 24,
        subtitleBgOpacity: 0.7,
        currentVolume: 1,
        currentSpeed: CONFIG.DEFAULT_SPEED,
        isAccelerating: false,
        eventListeners: new Map()
    };

    // ==================== 工具函数 ====================
    function debounce(fn, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    function showToast(msg, duration = 2000) {
        let toast = document.getElementById('av-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'av-toast';
            toast.style.cssText = `
                position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
                background: rgba(0,0,0,0.85); color: white;
                padding: 10px 16px; border-radius: 8px;
                z-index: 9999999; font-size: 13px;
                max-width: 85vw; word-break: break-word;
                pointer-events: none; transition: opacity 0.3s;
                white-space: nowrap;
            `;
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.style.opacity = '1';
        if (toast.timeoutId) clearTimeout(toast.timeoutId);
        toast.timeoutId = setTimeout(() => { toast.style.opacity = '0'; }, duration);
    }

    // ==================== 番号解析模块 ====================
    function parseVideoIDFromURL(url) {
        try {
            let path = url;
            try {
                const urlObj = new URL(url, location.origin);
                path = urlObj.pathname;
            } catch(e) {}

            const pathSegments = path.split('/').filter(s => s.length > 0);
            if (pathSegments.length === 0) return '';

            let lastSegment = pathSegments[pathSegments.length - 1];
            lastSegment = lastSegment.replace(/\.(html|htm|php|asp|jsp)$/i, '');

            let match = lastSegment.match(/([A-Za-z]{2,6})-(\d{3,6})/i);
            if (match) return `${match[1].toUpperCase()}-${match[2]}`;
            match = lastSegment.match(/([A-Za-z]{2,6})(\d{3,6})/i);
            if (match) return `${match[1].toUpperCase()}-${match[2]}`;
            match = lastSegment.match(/([A-Za-z]{2,6})-(\d{3,6})-([A-Za-z0-9]+)/i);
            if (match) return `${match[1].toUpperCase()}-${match[2]}`;
            match = lastSegment.match(/([A-Za-z]{2,6})_(\d{3,6})/i);
            if (match) return `${match[1].toUpperCase()}-${match[2]}`;
            return '';
        } catch (e) { return ''; }
    }

    function parseVideoIDFromTitle(title) {
        if (!title) return '';
        let match = title.match(/([A-Z]{2,6})-(\d{3,6})/);
        if (match) return `${match[1]}-${match[2]}`;
        match = title.match(/([A-Z]{2,6})(\d{3,6})/);
        if (match) return `${match[1]}-${match[2]}`;
        match = title.match(/FC2-?(\d{6,8})/i);
        if (match) return `FC2-${match[1]}`;
        return '';
    }

    function getCurrentVideoID() {
        let id = parseVideoIDFromURL(location.href);
        if (id && /^[A-Z]{2,6}-\d{3,6}$/.test(id)) return id;
        id = parseVideoIDFromTitle(document.title);
        if (id) return id;
        if (window.top !== window.self) {
            try {
                id = parseVideoIDFromTitle(window.top.document.title);
                if (id) return id;
            } catch(e) {}
        }
        return '';
    }

    function isValidVideoID(vid) {
        if (!vid) return false;
        if (/^[A-Z]{2,6}-\d{3,6}$/.test(vid)) return true;
        if (/^FC2-\d{6,8}$/i.test(vid)) return true;
        return false;
    }

    // ==================== 字幕API模块 ====================
    const requestAPI = typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null;

    function gmGetText(url, options = {}) {
        return new Promise((resolve, reject) => {
            if (!requestAPI) return reject(new Error('GM_xmlhttpRequest is missing'))
            requestAPI({
                method: 'GET', url: url, headers: options.headers || {}, timeout: options.timeout || 20000,
                onload: response => {
                    if (Number(response.status) >= 200 && Number(response.status) < 300) resolve(response.responseText || '')
                    else reject(new Error('请求失败：HTTP ' + response.status))
                },
                ontimeout: () => reject(new Error('请求超时')),
                onerror: () => reject(new Error('请求失败（网络或跨域被拦截）'))
            })
        })
    }

    function fetchSubtitleAPI(url) {
        return new Promise((resolve, reject) => {
            if (!requestAPI) return reject(new Error('GM_xmlhttpRequest is missing'));
            requestAPI({
                method: "GET",
                url: url,
                headers: {
                    "Accept": "application/json",
                    "X-Requested-With": "XMLHttpRequest",
                    "Cache-Control": "no-cache",
                    "Referer": location.href,
                    "Origin": location.origin
                },
                timeout: 15000,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        try { resolve(JSON.parse(res.responseText)); }
                        catch (e) { reject(new Error('JSON解析失败')); }
                    } else { reject(new Error(`HTTP错误 ${res.status}`)); }
                },
                onerror: () => reject(new Error('网络错误')),
                ontimeout: () => reject(new Error('请求超时'))
            });
        });
    }

    function searchXunlei(keyword) {
        return new Promise((resolve) => {
            requestAPI({
                method: 'GET',
                url: `https://api-shoulei-ssl.xunlei.com/oracle/subtitle?name=${encodeURIComponent(keyword)}`,
                timeout: 10000,
                onload: (res) => {
                    try {
                        const data = JSON.parse(res.responseText);
                        if (data.code === 0 && data.data) {
                            const supportedExts = ['.srt', '.vtt', '.ass'];
                            resolve(data.data.filter(i => i.url && supportedExts.some(ext => i.url.toLowerCase().includes(ext))).map(i => ({
                                name: i.name,
                                url: i.url,
                                source: '迅雷'
                            })));
                        } else resolve([]);
                    } catch (e) { resolve([]); }
                },
                onerror: () => resolve([])
            });
        });
    }

    function get115VideoID() {
        const text = [document.title, document.body?.innerText || ''].join(' ');
        const m = text.match(/\b([A-Za-z]{2,6}[-_ ]?\d{3,8})\b/);
        return m ? m[1].replace(' ','-').replace('_','-').toUpperCase() : '';
    }
    function fetchSubDogJSON(url) {
        return new Promise((resolve, reject) => {
            const token = localStorage.getItem('backend_auth_token') || '';
            requestAPI({ method:'GET', url, headers:{Accept:'application/json', ...(token ? {Authorization:'Bearer '+token} : {})}, timeout:20000,
                onload:r => { try { const data=JSON.parse(r.responseText||'{}'); resolve(data); } catch(e) { reject(e); } }, onerror:reject, ontimeout:reject });
        });
    }
    async function searchSubDog(keyword) {
        if (!/115\.com$/i.test(location.hostname) && !location.hostname.endsWith('.115.com')) return [];
        try {
            const data = await fetchSubDogJSON('https://api.sub-dog.top/api/subtitles/variants/'+encodeURIComponent(keyword));
            const variants = Array.isArray(data?.variants) ? data.variants : [];
            return (await Promise.all(variants.slice(0,12).map(async v => {
                const id=v.video_id||v.vid||v.id; if(!id) return null;
                try { const token=localStorage.getItem('backend_auth_token')||''; const text=await gmGetText('https://api.sub-dog.top/api/subtitle/'+encodeURIComponent(id), token?{Authorization:'Bearer '+token,Accept:'text/plain'}:{}); if(!text) return null; return {source:'字幕狗（115在线）',name:v.name||('字幕 '+id),url:'data:text/plain;charset=utf-8,'+encodeURIComponent(text),text,online:true}; } catch(e){ return null; }
            }))).filter(Boolean);
        } catch(e) { return []; }
    }

    async function searchSubtitleCat(keyword) {
        try {
            const html = await gmGetText('https://www.subtitlecat.com/index.php?search='+encodeURIComponent(keyword));
            const pages = [...html.matchAll(/href=["']([^"']*subs\/[^"']+\.html)["']/gi)].map(m => 'https://www.subtitlecat.com/'+m[1].replace(/^\.\//,''));
            const unique = [...new Set(pages)].slice(0, 5), out=[];
            for (const page of unique) { const h=await gmGetText(page); for (const m of h.matchAll(/href=["']([^"']+\.(?:srt|vtt|ass))["']/gi)) { const u=new URL(m[1].replace(/&amp;/g,'&'),page).href; out.push({source:'SubtitleCat',name:decodeURIComponent(u.split('/').pop()),url:u,online:true}); } }
            return out;
        } catch(e) { return []; }
    }

    async function searchYify(keyword) {
        return new Promise(resolve => requestAPI({method:'GET', url:'https://yifysubtitles.ch/search?q='+encodeURIComponent(keyword), timeout:15000,
            onload:r => { const html=r.responseText||''; const links=[...html.matchAll(/href=["'](\/subtitles\/[^"']+)["']/gi)].map(m=>m[1]); resolve([...new Set(links)].slice(0,8).map(path=>({source:'YIFY Subtitles',name:path.split('/').pop().replace(/-/g,' '),url:'https://yifysubtitles.ch'+path,webProvider:'yify'}))); }, onerror:()=>resolve([])}));
    }
    async function loadYifySubtitle(pageUrl) {
        return new Promise((resolve,reject)=>requestAPI({method:'GET',url:pageUrl,timeout:15000,onload:r=>{const m=(r.responseText||'').match(/href=["'](\/subtitle\/[^"']+\.zip)["']/i); if(!m)return reject(new Error('未找到字幕文件')); requestAPI({method:'GET',url:'https://yifysubtitles.ch'+m[1],responseType:'arraybuffer',onload:z=>{JSZip.loadAsync(z.response).then(zip=>{const f=Object.values(zip.files).find(x=>/\.(srt|vtt|ass)$/i.test(x.name)); if(!f)return reject(new Error('压缩包内无字幕')); f.async('text').then(resolve).catch(reject);}).catch(reject)},onerror:reject});},onerror:reject}));
    }

    function normalizeSubtitleKeyword(keyword) {
        return String(keyword || '').trim().replace(/\s+/g, ' ').toUpperCase()
    }

    function parseSubtitleCode(value) {
        const match = normalizeSubtitleKeyword(value).match(/^([A-Z]{2,10})[-_ ]?(\d{1,8})$/)
        if (!match) return null
        return { prefix: match[1], number: String(Number(match[2])) }
    }

    function subtitleResultMatchesKeyword(item, keyword) {
        const target = parseSubtitleCode(keyword)
        if (!target) return true
        const itemUrl = String(item && item.url || '')
        const source = [item && item.name, item && item.title, /^data:/i.test(itemUrl) ? '' : itemUrl, item && item.pageUrl]
            .filter(Boolean)
            .join(' ')
        const pattern = /(?:^|[^A-Z0-9])([A-Z]{2,10})[-_ ]?(\d{1,8})(?!\d)/gi
        for (const match of source.matchAll(pattern)) {
            if (match[1].toUpperCase() === target.prefix && String(Number(match[2])) === target.number) return true
        }
        return false
    }

    function subtitleResultMatchScore(item, keyword) {
        if (!subtitleResultMatchesKeyword(item, keyword)) return -1
        const compactKeyword = normalizeSubtitleKeyword(keyword).replace(/[\s_-]+/g, '')
        const name = normalizeSubtitleKeyword(item && item.name).replace(/[\s_-]+/g, '')
        const url = normalizeSubtitleKeyword(item && item.url).replace(/[\s_-]+/g, '')
        if (name.includes(compactKeyword)) return 3
        if (url.includes(compactKeyword)) return 2
        return 1
    }

    function readSubtitleSearchCache(keyword) {
        const key = normalizeSubtitleKeyword(keyword)
        if (!key) return []
        try {
            const cache = JSON.parse(localStorage.getItem(CONFIG.SEARCH_CACHE_KEY) || '{}')
            const entry = cache[key]
            if (!entry || !Array.isArray(entry.items)) return []
            if (Date.now() - Number(entry.timestamp || 0) > CONFIG.SEARCH_CACHE_TTL) {
                delete cache[key]
                localStorage.setItem(CONFIG.SEARCH_CACHE_KEY, JSON.stringify(cache))
                return []
            }
            return entry.items
        } catch (error) {
            return []
        }
    }

    function saveSubtitleSearchCache(keyword, items) {
        const key = normalizeSubtitleKeyword(keyword)
        if (!key || !Array.isArray(items)) return
        try {
            const cache = JSON.parse(localStorage.getItem(CONFIG.SEARCH_CACHE_KEY) || '{}')
            const cachedItems = items.slice(0, 20).map(item => {
                const result = {
                    source: item.source || '未知来源',
                    name: item.name || '字幕',
                    url: item.url || ''
                }
                if (item.webProvider) result.webProvider = item.webProvider
                if (item.browser) result.browser = true
                if (typeof item.containsChinese === 'boolean') result.containsChinese = item.containsChinese
                if (item.text && item.text.length <= 200000) result.text = item.text
                return result
            }).filter(item => item.url && item.url.length <= 300000)
            cache[key] = { timestamp: Date.now(), items: cachedItems }
            const entries = Object.entries(cache)
                .sort((a, b) => Number(b[1]?.timestamp || 0) - Number(a[1]?.timestamp || 0))
                .slice(0, CONFIG.SEARCH_CACHE_MAX_ENTRIES)
            localStorage.setItem(CONFIG.SEARCH_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)))
        } catch (error) {
            console.warn('[字幕搜索] 缓存保存失败：', error)
        }
    }

    function getSubtitlePreference() {
        try { return JSON.parse(localStorage.getItem(CONFIG.SUBTITLE_PREFERENCE_KEY) || 'null') } catch (error) { return null }
    }

    function rememberSubtitleSelection(keyword, item) {
        if (!item) return
        try {
            localStorage.setItem(CONFIG.SUBTITLE_PREFERENCE_KEY, JSON.stringify({
                keyword: normalizeSubtitleKeyword(keyword),
                source: item.source || '',
                name: item.name || '',
                url: item.url || '',
                timestamp: Date.now()
            }))
        } catch (error) {}
    }

    function subtitleMatchesPreference(item, preference, keyword) {
        if (!item || !preference) return false
        const compactKeyword = value => normalizeSubtitleKeyword(value).replace(/[\s_-]+/g, '')
        if (keyword && preference.keyword && compactKeyword(preference.keyword) !== compactKeyword(keyword)) return false
        if (preference.url && item.url === preference.url) return true
        return Boolean(preference.name && item.name === preference.name && preference.source === item.source)
    }

    function mergeSubtitleResults(target, items, keyword) {
        const seen = new Set(target.map(item => item.url || (item.source + '|' + item.name)))
        for (const item of items || []) {
            if (!subtitleResultMatchesKeyword(item, keyword)) continue
            const key = item.url || (item.source + '|' + item.name)
            if (!key || seen.has(key)) continue
            seen.add(key)
            target.push(item)
        }
        target.sort((a, b) => subtitleResultMatchScore(b, keyword) - subtitleResultMatchScore(a, keyword))
    }

    // ==================== 字幕解析模块 ====================
    function parseTime(t) {
        const [hms, ms] = t.split(/[,.]/);
        const [h, m, s] = hms.split(':');
        return (+h * 3600) + (+m * 60) + (+s) + (+ms / 1000);
    }

    async function parseSRT(text, offset = 0) {
        return text.replace(/\r/g, '').split(/\n\n+/).filter(Boolean).map(block => {
            const lines = block.split('\n');
            const timeLine = lines.find(l => l.includes(' --> '));
            if (!timeLine) return null;
            const [start, end] = timeLine.split(' --> ').map(parseTime);
            const textLines = lines.filter(l => !l.includes(' --> ') && !/^\d+$/.test(l));
            return { start: start + offset, end: end + offset, text: textLines.join('\n').trim() };
        }).filter(Boolean);
    }

    // ==================== 全局加速功能 ====================
    let globalSpeedInterval = null;

    function enableGlobalSpeed(speed = CONFIG.DEFAULT_SPEED) {
        if (globalSpeedInterval) clearInterval(globalSpeedInterval);
        globalSpeedInterval = setInterval(() => {
            document.querySelectorAll('video').forEach(video => {
                if (video.playbackRate !== speed && !video.paused) {
                    video.playbackRate = speed;
                }
            });
        }, 300);
        state.isAccelerating = true;
        showToast(`全局加速已启用：${speed}x`);
    }

    function disableGlobalSpeed() {
        if (globalSpeedInterval) {
            clearInterval(globalSpeedInterval);
            globalSpeedInterval = null;
        }
        state.isAccelerating = false;
        showToast('全局加速已关闭');
    }

    function toggleGlobalSpeed() {
        if (state.isAccelerating) disableGlobalSpeed();
        else enableGlobalSpeed(state.currentSpeed);
    }

    // ==================== 视频控制模块 ====================
    function shouldResumeBackgroundPlayback(video, guard) {
        return Boolean(guard && guard.wasPlayingBeforeHidden && video && video.paused && !video.ended);
    }

    function shouldKeepBackgroundPlayback(video, guard) {
        return Boolean(guard && guard.backgroundMode && guard.wasPlayingBeforeHidden && video && !video.ended);
    }

    const backgroundPlaybackGuards = new Set();
    let backgroundPlaybackLifecycleInstalled = false;
    let pageContextPauseGuardInstalled = false;

    function installPageContextPauseGuardBridge() {
        if (pageContextPauseGuardInstalled) return;
        pageContextPauseGuardInstalled = true;

        const patchPrototype = prototype => {
            if (!prototype || prototype.__avBackgroundPauseGuardInstalled || typeof prototype.pause !== 'function') return false;
            const originalPause = prototype.pause;
            const guardedPause = function () {
                if (this && this.dataset && this.dataset.avBackgroundKeepPlaying === '1' && !this.ended) {
                    try {
                        const playResult = this.play();
                        if (playResult && typeof playResult.catch === 'function') playResult.catch(() => {});
                    } catch (error) {}
                    return;
                }
                return originalPause.apply(this, arguments);
            };
            Object.defineProperty(prototype, 'pause', { configurable: true, writable: true, value: guardedPause });
            Object.defineProperty(prototype, '__avBackgroundPauseGuardInstalled', { configurable: false, value: true });
            return true;
        };

        try {
            const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            if (patchPrototype(pageWindow.HTMLMediaElement && pageWindow.HTMLMediaElement.prototype)) return;
        } catch (error) {}

        const source = `(() => {
            const prototype = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
            if (!prototype || prototype.__avBackgroundPauseGuardInstalled) return;
            const originalPause = prototype.pause;
            const guardedPause = function () {
                if (this && this.dataset && this.dataset.avBackgroundKeepPlaying === '1' && !this.ended) {
                    try {
                        const playResult = this.play();
                        if (playResult && typeof playResult.catch === 'function') playResult.catch(() => {});
                    } catch (error) {}
                    return;
                }
                return originalPause.apply(this, arguments);
            };
            Object.defineProperty(prototype, 'pause', { configurable: true, writable: true, value: guardedPause });
            Object.defineProperty(prototype, '__avBackgroundPauseGuardInstalled', { configurable: false, value: true });
        })();`;

        try {
            const target = document.documentElement || document.head || document.body;
            if (!target) {
                pageContextPauseGuardInstalled = false;
                return;
            }
            const script = document.createElement('script');
            script.textContent = source;
            target.appendChild(script);
            script.remove();
        } catch (error) {
            pageContextPauseGuardInstalled = false;
        }
    }

    function isPageHidden() {
        return document.hidden || document.visibilityState === 'hidden';
    }

    function installBackgroundPlaybackLifecycle() {
        if (backgroundPlaybackLifecycleInstalled) return;
        backgroundPlaybackLifecycleInstalled = true;

        const handleVisibility = () => {
            if (isPageHidden()) {
                backgroundPlaybackGuards.forEach(guard => guard.enterBackground());
            } else {
                backgroundPlaybackGuards.forEach(guard => guard.leaveBackground());
            }
        };

        document.addEventListener('visibilitychange', handleVisibility, true);
        window.addEventListener('blur', () => {
            backgroundPlaybackGuards.forEach(guard => guard.enterBackground());
        }, true);
        window.addEventListener('focus', () => {
            if (!isPageHidden()) {
                backgroundPlaybackGuards.forEach(guard => guard.leaveBackground());
            }
        }, true);
    }

    function installBackgroundPlaybackGuard(video) {
        if (!video || video._avBackgroundPlaybackGuard) return;
        installBackgroundPlaybackLifecycle();
        installPageContextPauseGuardBridge();

        const guard = {
            video,
            wasPlayingBeforeHidden: !video.paused && !video.ended,
            lastKnownPlaying: !video.paused && !video.ended,
            backgroundMode: false,
            keepAliveTimer: null,
            enterBackground() {
                if (video.ended) return;
                // blur 和 visibilitychange 可能连续触发，不能因第二次触发时
                // 播放器已经被浏览器暂停而丢失“之前正在播放”的状态。
                if (this.backgroundMode && this.wasPlayingBeforeHidden) return;
                const wasPlaying = (!video.paused && !video.ended) || this.lastKnownPlaying;
                this.wasPlayingBeforeHidden = wasPlaying;
                this.backgroundMode = wasPlaying;
                if (wasPlaying) {
                    video.dataset.avBackgroundKeepPlaying = '1';
                    this.startKeepAlive();
                } else {
                    delete video.dataset.avBackgroundKeepPlaying;
                    this.stopKeepAlive();
                }
            },
            leaveBackground() {
                const shouldResume = this.backgroundMode && shouldResumeBackgroundPlayback(video, this);
                this.backgroundMode = false;
                delete video.dataset.avBackgroundKeepPlaying;
                this.stopKeepAlive();
                if (shouldResume) this.resume(false);
                this.wasPlayingBeforeHidden = false;
                this.lastKnownPlaying = !video.paused && !video.ended;
            },
            startKeepAlive() {
                if (this.keepAliveTimer) return;
                this.keepAliveTimer = setInterval(() => {
                    if (!shouldKeepBackgroundPlayback(video, this)) {
                        this.stopKeepAlive();
                        return;
                    }
                    if (video.paused) this.resume();
                }, 1000);
            },
            stopKeepAlive() {
                if (this.keepAliveTimer) {
                    clearInterval(this.keepAliveTimer);
                    this.keepAliveTimer = null;
                }
            },
            resume() {
                if (!shouldResumeBackgroundPlayback(video, this)) return;
                try {
                    const playResult = video.play();
                    if (playResult && typeof playResult.catch === 'function') playResult.catch(() => {});
                } catch (error) {}
            },
            installPauseGuard() {
                try {
                    const originalPause = video.pause.bind(video);
                    video.pause = () => {
                        if (shouldKeepBackgroundPlayback(video, this)) {
                            this.resume();
                            return;
                        }
                        originalPause();
                    };
                } catch (error) {}
            },
            onPause() {
                const hidden = isPageHidden();
                const wasPlaying = this.lastKnownPlaying || this.backgroundMode;
                this.lastKnownPlaying = false;
                // 只在切到后台前确实处于播放状态时恢复，用户在前台手动暂停不会被改回播放。
                if ((hidden || this.backgroundMode) && wasPlaying && !video.ended) {
                    this.wasPlayingBeforeHidden = true;
                    this.backgroundMode = true;
                    video.dataset.avBackgroundKeepPlaying = '1';
                    this.startKeepAlive();
                    this.resume();
                }
            },
            onPlay() {
                this.lastKnownPlaying = true;
                // 后台续播成功后保留 backgroundMode，避免浏览器再次暂停时丢失续播意图。
                if (!this.backgroundMode) {
                    this.wasPlayingBeforeHidden = false;
                }
            },
            onEnded() {
                this.backgroundMode = false;
                this.wasPlayingBeforeHidden = false;
                this.lastKnownPlaying = false;
                delete video.dataset.avBackgroundKeepPlaying;
                this.stopKeepAlive();
            }
        };

        video._avBackgroundPlaybackGuard = guard;
        backgroundPlaybackGuards.add(guard);
        guard.installPauseGuard();
        video.addEventListener('pause', guard.onPause, true);
        video.addEventListener('play', guard.onPlay, true);
        video.addEventListener('ended', guard.onEnded, true);
    }

    function canBeControlled(video) {
        if (!video || video.tagName !== 'VIDEO') return false;
        const rect = video.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 100) return false;
        if (video.videoWidth === 0) return false;
        if (video.readyState < 1) return false;
        return true;
    }

    function autoSelectSingleVideo() {
        if (state.currentVideo && canBeControlled(state.currentVideo)) return;
        const videos = Array.from(document.querySelectorAll('video')).filter(canBeControlled);
        if (videos.length === 1) {
            switchToVideo(videos[0]);
        } else if (videos.length > 1) {
            const playing = videos.find(v => !v.paused);
            if (playing) switchToVideo(playing);
        }
    }

    function switchToVideo(video) {
        if (state.currentVideo === video) return;
        if (state.currentVideo && !state.currentVideo._isIframe) {
            if (state.eventListeners.has(state.currentVideo)) {
                state.eventListeners.get(state.currentVideo).forEach(({ event, handler }) => {
                    state.currentVideo.removeEventListener(event, handler, true);
                });
                state.eventListeners.delete(state.currentVideo);
            }
            const oldOverlay = document.querySelector('.av-subtitle-overlay');
            if (oldOverlay) oldOverlay.remove();
        }

        state.currentVideo = video;
        if (video && !video._isIframe) {
            installBackgroundPlaybackGuard(video);
            video.dataset.avSelected = 'true';
            if (state.isAccelerating) video.playbackRate = state.currentSpeed;
            video.volume = state.currentVolume;

            const updateTime = debounce(() => {
                if (state.subtitleData.length > 0) updateSubtitleDisplay(video.currentTime);
            }, 30);

            video.addEventListener('timeupdate', updateTime, true);
            video.addEventListener('volumechange', () => {
                state.currentVolume = video.volume;
                updateVolumeDisplay();
            });
            state.eventListeners.set(video, [{ event: 'timeupdate', handler: updateTime }]);
            if (state.subtitleData.length > 0) createSubtitleOverlay(video);
        }
        updateRestoreBtnStyle(true);
        showToast('已接管视频控制');
    }

    // ==================== 字幕功能模块 ====================
    function createSubtitleOverlay(video) {
        if (video._isIframe) return null;
        const old = document.querySelector('.av-subtitle-overlay');
        if (old) old.remove();
        const overlay = document.createElement('div');
        overlay.className = 'av-subtitle-overlay';
        let parent = video.parentElement || document.body;
        if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
        parent.appendChild(overlay);
        applySubtitleStyle();
        return overlay;
    }

    function applySubtitleStyle() {
        const overlay = document.querySelector('.av-subtitle-overlay');
        if (!overlay) return;
        overlay.style.cssText = `
            position: absolute !important; bottom: 8% !important; left: 50% !important;
            transform: translateX(-50%) !important; width: auto !important;
            max-width: 90% !important; text-align: center !important;
            color: white !important; font-size: ${state.subtitleFontSize}px !important;
            background: rgba(0,0,0,${state.subtitleBgOpacity}) !important;
            padding: 8px 16px !important;
            border-radius: 8px !important; z-index: 9999 !important;
            pointer-events: none !important; white-space: pre-wrap !important;
            font-weight: ${state.subtitleStyle === 'bold' ? 'bold' : 'normal'} !important;
            text-shadow: ${state.subtitleStyle === 'stroke' ? '1px 1px 0 #000' : 'none'} !important;
        `;
    }

    function updateSubtitleDisplay(currentTime) {
        const overlay = document.querySelector('.av-subtitle-overlay');
        if (!overlay || state.subtitleData.length === 0) return;
        if (!state.subtitleEnabled) {
            overlay.style.display = 'none';
            return;
        }
        const time = currentTime + state.subtitleOffset;
        const subtitle = state.subtitleData.find(s => time >= s.start && time <= s.end);
        if (subtitle) {
            overlay.textContent = subtitle.text;
            overlay.style.display = 'block';
        } else {
            overlay.style.display = 'none';
        }
    }

    function adjustOffset(delta, reset = false) {
        if (reset) state.subtitleOffset = 0;
        else state.subtitleOffset += delta;
        const span = document.getElementById('av-offset-value');
        if (span) span.textContent = `${state.subtitleOffset > 0 ? '+' : ''}${state.subtitleOffset.toFixed(1)}s`;
        if (state.currentVideo && state.subtitleData.length > 0 && state.subtitleEnabled) {
            updateSubtitleDisplay(state.currentVideo.currentTime);
        }
    }

    function toggleSubtitle() {
        state.subtitleEnabled = !state.subtitleEnabled;
        const toggle = document.getElementById('av-zimu-toggle');
        if (toggle) toggle.classList.toggle('active', state.subtitleEnabled);
        const overlay = document.querySelector('.av-subtitle-overlay');
        if (overlay) overlay.style.display = state.subtitleEnabled ? 'block' : 'none';
        showToast(state.subtitleEnabled ? '字幕已开启' : '字幕已关闭');
    }

    function changeFontSize(delta) {
        const newSize = state.subtitleFontSize + delta;
        if (newSize >= 12 && newSize <= 48) {
            state.subtitleFontSize = newSize;
            const fontSizeSpan = document.getElementById('av-font-size');
            if (fontSizeSpan) fontSizeSpan.textContent = state.subtitleFontSize + 'px';
            applySubtitleStyle();
        }
    }

    function changeBgOpacity(delta) {
        let newOpacity = state.subtitleBgOpacity + delta;
        if (newOpacity >= 0 && newOpacity <= 1) {
            state.subtitleBgOpacity = Math.round(newOpacity * 10) / 10;
            const bgSpan = document.getElementById('av-bg-opacity-value');
            if (bgSpan) bgSpan.textContent = Math.round(state.subtitleBgOpacity * 100) + '%';
            applySubtitleStyle();
        }
    }

    function changeStyle(style) {
        state.subtitleStyle = style;
        applySubtitleStyle();
    }

    function clearSubtitle() {
        state.subtitleData = [];
        state.lastSubtitleIndex = -1;
        state.subtitleOffset = 0;

        const offsetSpan = document.getElementById('av-offset-value');
        if (offsetSpan) offsetSpan.textContent = '0.0s';

        const overlay = document.querySelector('.av-subtitle-overlay');
        if (overlay) overlay.remove();

        const toggle = document.getElementById('av-zimu-toggle');
        if (toggle) {
            state.subtitleEnabled = true;
            toggle.classList.add('active');
        }

        showToast('字幕已清除');
    }

    // ==================== 字幕搜索加载模块 ====================
    let subtitleList = null;
    let subtitleSearchSequence = 0;
    let subtitleSearchRefresh = null;

    function showSubtitleList(items) {
        if (subtitleList) subtitleList.remove();
        subtitleList = document.createElement('div');
        subtitleList.className = 'av-subtitle-list';
        const preference = getSubtitlePreference();
        const currentKeyword = getCurrentVideoID();

        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const estimatedHeight = Math.min(items.length * 55 + 60, viewportHeight * 0.7);

        let leftPos = 20;
        let topPos = viewportHeight - estimatedHeight - 20;
        if (topPos < 20) topPos = 20;
        if (leftPos + 400 > viewportWidth - 20) {
            leftPos = viewportWidth - 420;
            if (leftPos < 20) leftPos = 20;
        }

        subtitleList.style.left = leftPos + 'px';
        subtitleList.style.top = topPos + 'px';

        subtitleList.innerHTML = `<div class="av-list-title"><span>📋 选择字幕 (${items.length}条)</span><span class="av-list-close">✕</span></div>`;
        subtitleList.querySelector('.av-list-close').onclick = () => subtitleList.remove();

        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'av-list-item';
            div.dataset.subtitleKey = subtitleItemKey(item);
            if (subtitleMatchesPreference(item, preference, currentKeyword)) div.classList.add('selected');
            let displayName = item.name;
            let fullName = item.name;
            if (displayName.length > 60) displayName = displayName.substring(0, 57) + '...';
            const language = getSubtitleLanguageLabel(item);
            div.innerHTML = `<div class="av-list-item-info"><div class="av-list-item-source">${item.source}<span class="av-language-badge ${language.className}">${language.text}</span></div><div class="av-list-item-name" title="${fullName.replace(/"/g, '&quot;')}">${displayName}</div></div><span class="av-sub-action-group"><button class="av-dl-btn">↓ 下载</button><button class="av-115-sub-btn">存115</button></span>`;
            div.querySelector('.av-dl-btn').onclick = (e) => { e.stopPropagation(); downloadSubtitleFile(item.url, item.name); };
            div.querySelector('.av-115-sub-btn').onclick = (e) => { e.stopPropagation(); saveSubtitleItemTo115(item, e.currentTarget); };
            div.onclick = () => { rememberSubtitleSelection(currentKeyword, item); updateSubtitleSelectionHighlight(item); if (item.text) { state.subtitleData = parseSRT(item.text, state.subtitleOffset); if (state.currentVideo) createSubtitleOverlay(state.currentVideo); showToast('字幕狗字幕加载成功'); return; }
                    if (item.browser) { GM_openInTab(item.url, {active:true, insert:true}); return; }
                    if (item.webProvider === 'yify') { loadYifySubtitle(item.url).then(text => { state.subtitleData = parseSRT(text, state.subtitleOffset); if (state.currentVideo) createSubtitleOverlay(state.currentVideo); showToast('YIFY 字幕加载成功'); }).catch(() => showToast('YIFY 字幕加载失败')); return; }
                    loadRemoteSubtitle(item.url); subtitleList.remove(); };
            subtitleList.appendChild(div);
        });
        document.body.appendChild(subtitleList);

        setTimeout(() => {
            const closeHandler = (e) => {
                if (!subtitleList?.contains(e.target)) { subtitleList?.remove(); document.removeEventListener('click', closeHandler); }
            };
            document.addEventListener('click', closeHandler);
        }, 150);
    }

    function showSubtitlePreview(text, name) {
        const box=document.createElement('div'); box.className='av-subtitle-preview'; box.innerHTML='<div class="av-preview-head"><b>'+String(name||'字幕预览').replace(/[<>]/g,'')+'</b><button>关闭</button></div><pre></pre>';
        box.querySelector('pre').textContent=text; box.querySelector('button').onclick=()=>box.remove(); document.body.appendChild(box);
    }

    async function downloadSubtitleFile(url, name) {
        try {
            const blob = await new Promise((resolve, reject) => {
                requestAPI({ url: url, responseType: 'blob', onload: (r) => r.status === 200 ? resolve(r.response) : reject(), onerror: reject });
            });
            const downloadUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = (name || 'subtitle').replace(/[<>:"/\\|?*]/g, '_') + '.srt';
            a.click();
            URL.revokeObjectURL(downloadUrl);
            showToast('字幕下载成功');
        } catch (e) { showToast('下载失败'); }
    }

    async function getSubtitleTextFor115(item) {
        if (item && item.text) return String(item.text)
        if (item && item.webProvider === 'yify') return await loadYifySubtitle(item.url)
        const url = String(item && item.url || '')
        if (/^data:/i.test(url)) {
            const comma = url.indexOf(',')
            if (comma >= 0) return decodeURIComponent(url.slice(comma + 1))
        }
        if (!url) throw new Error('字幕没有可读取的地址')
        return await gmGetText(url)
    }

    function getSubtitleChineseOnly() {
        try { return localStorage.getItem(CONFIG.CHINESE_ONLY_KEY) === '1' } catch (error) { return false }
    }

    function setSubtitleChineseOnly(value) {
        try { localStorage.setItem(CONFIG.CHINESE_ONLY_KEY, value ? '1' : '0') } catch (error) {}
    }

    function subtitleHasChinese(text) {
        return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(String(text || '').slice(0, 300000))
    }

    function getSubtitleLanguageLabel(item) {
        if (item && item.chineseStatus === 'checking') return { text: '检查中', className: 'checking' }
        if (item && item.containsChinese === true) return { text: '中文', className: 'chinese' }
        if (item && item.containsChinese === false) return { text: '非中文', className: 'non-chinese' }
        return { text: '未知', className: 'unknown' }
    }

    function ensureSubtitleLanguage(item) {
        if (!item) return Promise.resolve(null)
        if (typeof item.containsChinese === 'boolean') {
            item.chineseStatus = item.containsChinese ? 'chinese' : 'non-chinese'
            return Promise.resolve(item.containsChinese)
        }
        if (item.chineseStatus === 'checking' && item.chineseCheckPromise) return item.chineseCheckPromise
        if (item.chineseStatus === 'unknown') return Promise.resolve(null)
        item.chineseStatus = 'checking'
        item.chineseCheckPromise = getSubtitleTextFor115(item).then(text => {
            item.containsChinese = subtitleHasChinese(text)
            item.chineseStatus = item.containsChinese ? 'chinese' : 'non-chinese'
            return item.containsChinese
        }).catch(error => {
            item.containsChinese = null
            item.chineseStatus = 'unknown'
            item.chineseCheckError = error && error.message ? error.message : '读取字幕失败'
            return null
        })
        return item.chineseCheckPromise
    }

    function subtitleItemKey(item) {
        return String(item && item.url || (item && item.source || '') + '|' + (item && item.name || ''))
    }

    function updateSubtitleSelectionHighlight(item) {
        const key = subtitleItemKey(item)
        document.querySelectorAll('.av-result-item, .av-list-item').forEach(node => {
            node.classList.toggle('selected', node.dataset.subtitleKey === key)
        })
    }

    function getSubtitleBridge() {
        if (typeof window !== 'undefined' && typeof window.__missav115SaveSubtitle === 'function') {
            return window.__missav115SaveSubtitle
        }
        try {
            if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.__missav115SaveSubtitle === 'function') {
                return unsafeWindow.__missav115SaveSubtitle
            }
        } catch (error) {}
        return null
    }

    async function saveSubtitleItemTo115(item, button) {
        const bridge = getSubtitleBridge()
        const code = getCurrentVideoID()
        if (typeof bridge !== 'function') {
            showToast('115同步模块尚未就绪，请刷新页面后重试')
            return
        }
        if (!code) {
            showToast('无法识别当前番号，不能定位115文件夹')
            return
        }
        if (button) {
            button.disabled = true
            button.dataset.originalText = button.textContent
            button.textContent = '读取…'
        }
        try {
            const text = await getSubtitleTextFor115(item)
            if (button) button.textContent = '转存…'
            const result = await bridge({ code: code, name: item && item.name, text: text })
            if (result.status === 'exists') showToast('115中已存在同名字幕：' + result.fileName)
            else showToast('字幕已存入115：' + result.folderName + '/' + result.fileName, 3500)
        } catch (error) {
            if (error && error.code === 'folder-missing') showToast('115没有找到同番号文件夹，请先下载视频', 3500)
            else if (error && error.type === 'auth') showToast('当前浏览器没有可用的115登录状态', 3500)
            else showToast('字幕转存115失败：' + (error && error.message ? error.message : '未知错误'), 4000)
        } finally {
            if (button) {
                button.disabled = false
                button.textContent = button.dataset.originalText || '存115'
                delete button.dataset.originalText
            }
        }
    }

    async function loadRemoteSubtitle(url) {
        showToast('正在加载字幕...');
        try {
            const content = await new Promise((resolve, reject) => {
                requestAPI({ url: url, onload: r => resolve(r.responseText), onerror: reject });
            });
            const parsed = await parseSRT(content, state.subtitleOffset);
            if (parsed.length === 0) throw new Error('解析失败');
            state.subtitleData = parsed;
            state.lastSubtitleIndex = -1;
            if (state.currentVideo) {
                createSubtitleOverlay(state.currentVideo);
                showToast(`字幕加载成功：${parsed.length} 条`);
                if (state.subtitleEnabled) updateSubtitleDisplay(state.currentVideo.currentTime);
            } else {
                showToast(`字幕已加载：${parsed.length} 条（请先播放视频）`);
            }
        } catch (e) { showToast('字幕加载失败'); }
    }

    async function searchSubtitle() {
        const searchId = ++subtitleSearchSequence
        const input = document.getElementById('av-search-input')
        const keyword = input?.value.trim() || getCurrentVideoID()
        if (!keyword) { showToast('请输入关键词或番号'); return }
        if (input) input.value = keyword
        const box = document.getElementById('av-result-list')
        if (!box) return
        box.classList.add('show')
        const cached = readSubtitleSearchCache(keyword)
        const all = []
        mergeSubtitleResults(all, cached, keyword)
        let searching = true

        const render = () => {
            if (searchId !== subtitleSearchSequence) return
            box.innerHTML = ''
            if (!all.length) {
                box.innerHTML = searching
                    ? '<div class="av-loading">🔍 搜索中，结果将按到达顺序显示...</div>'
                    : '<div class="av-empty">📭 未找到字幕</div>'
                return
            }
            const preference = getSubtitlePreference()
            const chineseOnly = getSubtitleChineseOnly()
            const pendingLanguageChecks = all.filter(item => item.chineseStatus === 'checking' || !item.chineseStatus).length
            const visibleItems = chineseOnly ? all.filter(item => item.containsChinese === true) : all
            all.forEach(item => {
                if (item.chineseStatus) return
                ensureSubtitleLanguage(item).then(() => {
                    if (searchId !== subtitleSearchSequence) return
                    saveSubtitleSearchCache(keyword, all)
                    render()
                })
            })
            if (chineseOnly && !visibleItems.length && pendingLanguageChecks) {
                box.innerHTML = '<div class="av-loading">正在读取字幕正文，筛选含中文的字幕…</div>'
                return
            }
            if (cached.length && searching) {
                const cacheNote = document.createElement('div')
                cacheNote.className = 'av-search-cache-note'
                cacheNote.textContent = chineseOnly
                    ? '正在检查字幕正文，只显示含中文的结果…'
                    : '已显示缓存结果，正在刷新其他来源…'
                box.appendChild(cacheNote)
            }
            if (chineseOnly && !visibleItems.length) {
                box.innerHTML = '<div class="av-empty">未检测到含中文的字幕</div>'
                return
            }
            visibleItems.slice(0, 20).forEach(item => {
                const d = document.createElement('div')
                d.className = 'av-result-item'
                d.dataset.subtitleKey = subtitleItemKey(item)
                if (subtitleMatchesPreference(item, preference, keyword)) d.classList.add('selected')
                const n = item.name || '字幕'
                const language = getSubtitleLanguageLabel(item)
                d.innerHTML = `<span class="av-result-source">${item.source}<span class="av-language-badge ${language.className}">${language.text}</span></span><span class="av-result-name" title="${n.replace(/"/g, '&quot;')}">${n.length > 50 ? n.slice(0, 47) + '...' : n}</span><button class="av-mini-btn av-preview-sub">预览</button><button class="av-mini-btn av-download-sub">↓</button><button class="av-mini-btn av-save-115">存115</button>`
                d.querySelector('.av-download-sub').onclick = e => {
                    e.stopPropagation()
                    downloadSubtitleFile(item.url, item.name)
                }
                d.querySelector('.av-preview-sub').onclick = async e => {
                    e.stopPropagation()
                    rememberSubtitleSelection(keyword, item)
                    updateSubtitleSelectionHighlight(item)
                    try { showSubtitlePreview(await getSubtitleTextFor115(item), item.name) } catch (_) { showToast('预览失败') }
                }
                d.querySelector('.av-save-115').onclick = e => {
                    e.stopPropagation()
                    saveSubtitleItemTo115(item, e.currentTarget)
                }
                d.onclick = () => {
                    rememberSubtitleSelection(keyword, item)
                    updateSubtitleSelectionHighlight(item)
                    if (item.text) {
                        state.subtitleData = parseSRT(item.text, state.subtitleOffset)
                        if (state.currentVideo) createSubtitleOverlay(state.currentVideo)
                        showToast('字幕加载成功')
                    } else if (item.webProvider === 'yify') {
                        loadYifySubtitle(item.url).then(t => {
                            state.subtitleData = parseSRT(t, state.subtitleOffset)
                            if (state.currentVideo) createSubtitleOverlay(state.currentVideo)
                            showToast('YIFY字幕加载成功')
                        }).catch(() => showToast('YIFY字幕加载失败'))
                    } else {
                        loadRemoteSubtitle(item.url)
                    }
                }
                box.appendChild(d)
            })
        }

        subtitleSearchRefresh = render
        render()
        const jobs = [searchXunlei(keyword), searchSubDog(keyword), searchSubtitleCat(keyword), searchYify(keyword)]
        await Promise.all(jobs.map(p => p.then(items => {
            if (searchId !== subtitleSearchSequence) return
            mergeSubtitleResults(all, items, keyword)
            render()
        }).catch(() => {})))
        if (searchId !== subtitleSearchSequence) return
        searching = false
        saveSubtitleSearchCache(keyword, all)
        render()
    }

    // ==================== UI更新函数 ====================
    function updateVolumeDisplay() {
        const display = document.getElementById('av-volume-value');
        if (display) display.textContent = Math.round(state.currentVolume * 100) + '%';
        const slider = document.getElementById('av-volume-slider');
        if (slider) slider.value = state.currentVolume;
    }

    function updateSpeedDisplay() {
        const display = document.getElementById('av-current-speed');
        if (display) display.textContent = state.currentSpeed.toFixed(1) + 'x';
    }

    function updateRestoreBtnStyle(hasVideo) {
        const btn = document.getElementById('av-restore-btn');
        if (btn) {
            if (hasVideo) { btn.classList.add('active'); btn.title = '视频已接管'; }
            else { btn.classList.remove('active'); btn.title = '显示视频助手'; }
        }
    }

    function autoFillSearchBox() {
        const searchInput = document.getElementById('av-search-input');
        if (searchInput && !searchInput.value.trim()) {
            const videoId = getCurrentVideoID() || (location.hostname.endsWith("115.com") ? get115VideoID() : "");
            if (videoId) searchInput.value = videoId;
        }
    }

    let autoSubtitleSearchStarted = false
    function autoOpenAndSearchSubtitle(attempt) {
        if (autoSubtitleSearchStarted) return
        const is115VideoPage = location.hostname.endsWith('115.com') && /\/web\/lixian\/master\/video\//i.test(location.pathname)
        const videoId = getCurrentVideoID() || (is115VideoPage ? get115VideoID() : '')
        if (!isValidVideoID(videoId)) {
            if ((attempt || 0) < 4) setTimeout(() => autoOpenAndSearchSubtitle((attempt || 0) + 1), 500)
            return
        }
        const panel = document.getElementById('av-main-panel')
        const restoreBtn = document.getElementById('av-restore-btn')
        const searchContent = document.getElementById('av-subtitle-search-content')
        const input = document.getElementById('av-search-input')
        if (!panel || !searchContent || !input) return
        autoSubtitleSearchStarted = true
        panel.classList.remove('hidden')
        // 右侧入口始终保留。部分站点会给 .hidden 追加全局样式，
        // 自动搜索失败或番号识别延迟时会导致视频控制入口一起消失。
        if (restoreBtn) {
            restoreBtn.classList.remove('hidden')
            restoreBtn.title = '打开视频助手（视频控制 / 字幕搜索）'
        }
        searchContent.classList.remove('collapsed')
        localStorage.setItem('av-collapse-subtitle-search', 'false')
        input.value = videoId
        setTimeout(() => searchSubtitle(), 80)
    }

    // ==================== 折叠面板功能 ====================
    function initCollapsibleSections() {
        const sections = ['video-control', 'subtitle-adjust', 'subtitle-search'];
        sections.forEach(id => {
            const header = document.getElementById(`av-${id}-header`);
            const content = document.getElementById(`av-${id}-content`);
            if (header && content) {
                const savedState = localStorage.getItem(`av-collapse-${id}`) !== 'false';
                if (!savedState) content.classList.add('collapsed');
                header.addEventListener('click', (e) => {
                    e.stopPropagation();
                    content.classList.toggle('collapsed');
                    localStorage.setItem(`av-collapse-${id}`, !content.classList.contains('collapsed'));
                });
            }
        });
    }

    // ==================== 列表页字幕探测 ====================
    let discoveryQueue = [];
    let isProcessingDiscovery = false;

    function updateCache(vid, hasSubtitle) {
        const cache = JSON.parse(localStorage.getItem(CONFIG.CACHE_KEY) || '{}');
        cache[vid] = { v: CONFIG.CACHE_VERSION, has: hasSubtitle, timestamp: Date.now() };
        localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify(cache));
    }

    function getCachedStatus(vid) {
        const cache = JSON.parse(localStorage.getItem(CONFIG.CACHE_KEY) || '{}');
        const entry = cache[vid];
        if (entry && entry.v === CONFIG.CACHE_VERSION) {
            const isValid = (Date.now() - entry.timestamp) < CONFIG.CACHE_EXPIRATION_DAYS * 86400000;
            if (isValid && entry.has !== undefined) return entry.has;
        }
        return null;
    }

    function applyResultToBtn(btn, has) {
        btn.textContent = has ? '有字幕' : '无字幕';
        btn.style.backgroundColor = has ? '#28a74500' : '#6c757d00';
    }

    async function processDiscoveryQueue() {
        if (discoveryQueue.length === 0) { isProcessingDiscovery = false; return; }
        isProcessingDiscovery = true;
        const task = discoveryQueue.shift();
        try {
            const data = await fetchSubtitleAPI(`https://api-shoulei-ssl.xunlei.com/oracle/subtitle?name=${encodeURIComponent(task.vid)}`);
            if (data.code === 0 && Array.isArray(data.data)) {
                const hasSubtitle = data.data.some(item => item.url && /\.(srt|vtt|ass)/i.test(item.url));
                updateCache(task.vid, hasSubtitle);
                applyResultToBtn(task.btn, hasSubtitle);
            } else {
                task.btn.textContent = '错误';
                task.btn.style.backgroundColor = '#dc3545';
            }
        } catch (e) {
            task.btn.textContent = '重试';
            task.btn.style.backgroundColor = '#ff9800';
            task.btn.onclick = () => { discoveryQueue.unshift(task); if (!isProcessingDiscovery) processDiscoveryQueue(); task.btn.onclick = null; };
        }
        setTimeout(processDiscoveryQueue, CONFIG.API_REQUEST_DELAY);
    }

    function addDiscoveryButton(card) {
        const link = card.querySelector('a');
        if (!link) return;
        const vid = parseVideoIDFromURL(link.href);
        if (!vid || !isValidVideoID(vid)) return;
        if (card.querySelector('.av-subtitle-badge')) return;
        const badge = document.createElement('div');
        badge.className = 'av-subtitle-badge';
        const cached = getCachedStatus(vid);
        if (cached !== null) {
            badge.textContent = cached ? '有字幕' : '无字幕';
            badge.style.backgroundColor = cached ? '#28a74500' : '#6c757d00';
        } else {
            badge.textContent = '探测中';
            badge.style.backgroundColor = '#007bff0';
            discoveryQueue.push({ vid, btn: badge });
            if (!isProcessingDiscovery) processDiscoveryQueue();
        }
        const container = card.querySelector('.card-img-top, .aspect-w-16, img, .poster')?.parentElement || card;
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
        container.appendChild(badge);
    }

    function initListPageDiscovery() {
        setTimeout(() => {
            document.querySelectorAll(CONFIG.VIDEO_CARD_SELECTOR).forEach(card => addDiscoveryButton(card));
        }, 1500);

        const observer = new MutationObserver((mutations) => {
            mutations.forEach(m => {
                m.addedNodes.forEach(node => {
                    if (node.nodeType === 1) {
                        if (node.matches?.(CONFIG.VIDEO_CARD_SELECTOR)) addDiscoveryButton(node);
                        else node.querySelectorAll?.(CONFIG.VIDEO_CARD_SELECTOR).forEach(addDiscoveryButton);
                    }
                });
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });

        setInterval(() => {
            document.querySelectorAll(CONFIG.VIDEO_CARD_SELECTOR).forEach(card => {
                const link = card.querySelector('a');
                if (!link) return;
                const vid = parseVideoIDFromURL(link.href);
                if (!vid || !isValidVideoID(vid)) return;
                if (!card.querySelector('.av-subtitle-badge')) addDiscoveryButton(card);
            });
        }, 5000);
    }

    // ==================== 主面板创建 ====================
    function createPanel() {
        if (document.getElementById('av-main-panel')) return;

        // 可拖拽的恢复按钮
        const restoreBtn = document.createElement('div');
        restoreBtn.id = 'av-restore-btn';
        restoreBtn.innerHTML = '🎬';
        restoreBtn.title = '显示视频助手（可拖拽移动）';

        let restoreBtnDragging = false;
        let restoreBtnStartY = 0, restoreBtnStartX = 0;
        let restoreBtnStartTop = 0, restoreBtnStartLeft = 0;

        const savedRestoreTop = localStorage.getItem('av-restore-btn-top');
        const savedRestoreLeft = localStorage.getItem('av-restore-btn-left');
        if (savedRestoreTop && savedRestoreLeft) {
            restoreBtn.style.top = savedRestoreTop;
            restoreBtn.style.left = savedRestoreLeft;
            restoreBtn.style.right = 'auto';
            restoreBtn.style.transform = 'none';
        } else if (savedRestoreTop) {
            restoreBtn.style.top = savedRestoreTop;
            restoreBtn.style.transform = 'none';
        }

        restoreBtn.onmousedown = (e) => {
            e.stopPropagation();
            restoreBtnDragging = false;
            restoreBtnStartY = e.clientY;
            restoreBtnStartX = e.clientX;

            const rect = restoreBtn.getBoundingClientRect();
            restoreBtnStartTop = rect.top;
            restoreBtnStartLeft = rect.left;

            restoreBtn.classList.add('dragging');

            document.onmousemove = (moveEvent) => {
                if (Math.abs(moveEvent.clientY - restoreBtnStartY) > 3 ||
                    Math.abs(moveEvent.clientX - restoreBtnStartX) > 3) {
                    restoreBtnDragging = true;
                }

                if (restoreBtnDragging) {
                    let newTop = restoreBtnStartTop + (moveEvent.clientY - restoreBtnStartY);
                    let newLeft = restoreBtnStartLeft + (moveEvent.clientX - restoreBtnStartX);

                    newTop = Math.max(0, Math.min(newTop, window.innerHeight - restoreBtn.offsetHeight));
                    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - restoreBtn.offsetWidth));

                    restoreBtn.style.top = newTop + 'px';
                    restoreBtn.style.left = newLeft + 'px';
                    restoreBtn.style.right = 'auto';
                    restoreBtn.style.transform = 'none';
                }
            };

            document.onmouseup = () => {
                document.onmousemove = null;
                document.onmouseup = null;
                restoreBtn.classList.remove('dragging');

                if (restoreBtnDragging) {
                    localStorage.setItem('av-restore-btn-top', restoreBtn.style.top);
                    localStorage.setItem('av-restore-btn-left', restoreBtn.style.left);
                    setTimeout(() => { restoreBtnDragging = false; }, 100);
                }
            };
        };

        restoreBtn.onclick = (e) => {
            if (restoreBtnDragging) {
                e.stopPropagation();
                return;
            }
            const panel = document.getElementById('av-main-panel');
            if (panel) {
                panel.classList.remove('hidden');
                // 入口保留在侧边，方便随时再次打开视频控制和字幕搜索。
                restoreBtn.classList.remove('hidden');
                autoFillSearchBox();
            }
        };

        document.body.appendChild(restoreBtn);

        // 主面板 - 字幕调整直接嵌入
        const panel = document.createElement('div');
        panel.id = 'av-main-panel';
        panel.className = 'hidden';
        panel.innerHTML = `
            <div class="av-panel-header"><span>🎬 视频助手</span><button id="av-minimize">−</button></div>
            <div class="av-panel-body">
                <!-- 视频控制区 -->
                <div class="av-section">
                    <div class="av-section-header" id="av-video-control-header">
                        <span>▶ 视频控制</span>
                        <span class="av-toggle-icon">▼</span>
                    </div>
                    <div class="av-section-content" id="av-video-control-content">
                        <div class="av-control-row">
                            <button class="av-seek-btn" data-seek="-10">◀◀ 10s</button>
                            <button class="av-seek-btn" data-seek="-5">◀ 5s</button>
                            <button id="av-play-pause">▶ 播放</button>
                            <button class="av-seek-btn" data-seek="5">5s ▶</button>
                            <button class="av-seek-btn" data-seek="10">10s ▶▶</button>
                        </div>
                        <div class="av-control-row">
                            <span>🔊</span>
                            <input type="range" id="av-volume-slider" min="0" max="1" step="0.05" value="1">
                            <span id="av-volume-value">100%</span>
                            <span>⚡</span>
                            <button id="av-speed-toggle" class="av-speed-btn">${state.currentSpeed}x</button>
                            <button id="av-global-toggle" class="av-global-btn ${state.isAccelerating ? 'active' : ''}">🌍 全局加速</button>
                        </div>
                    </div>
                </div>

                <!-- 字幕调整区（嵌入主面板） -->
                <div class="av-section">
                    <div class="av-section-header" id="av-subtitle-adjust-header">
                        <span>📝 字幕调整</span>
                        <span class="av-toggle-icon">▼</span>
                    </div>
                    <div class="av-section-content" id="av-subtitle-adjust-content">
                        <div class="av-adjust-row">
                            <span>🔘 开关</span>
                            <div id="av-zimu-toggle" class="av-toggle-switch active"><div class="av-toggle-slider"></div></div>
                            <span style="margin-left: auto;">📊 偏移</span>
                            <button class="av-offset-btn" id="av-offset-minus">−</button>
                            <span id="av-offset-value">0.0s</span>
                            <button class="av-offset-btn" id="av-offset-plus">+</button>
                            <button id="av-offset-reset" class="av-reset-btn">重置</button>
                        </div>
                        <div class="av-adjust-row">
                            <span>🔤 字号</span>
                            <button class="av-size-btn" id="av-font-minus">−</button>
                            <span id="av-font-size">${state.subtitleFontSize}px</span>
                            <button class="av-size-btn" id="av-font-plus">+</button>
                            <select id="av-style-select">
                                <option value="none" ${state.subtitleStyle === 'none' ? 'selected' : ''}>无效果</option>
                                <option value="stroke" ${state.subtitleStyle === 'stroke' ? 'selected' : ''}>描边</option>
                                <option value="bold" ${state.subtitleStyle === 'bold' ? 'selected' : ''}>加粗</option>
                            </select>
                        </div>
                        <div class="av-adjust-row">
                            <span>🎨 背景</span>
                            <button class="av-size-btn" id="av-bg-minus">−</button>
                            <span id="av-bg-opacity-value">${Math.round(state.subtitleBgOpacity * 100)}%</span>
                            <button class="av-size-btn" id="av-bg-plus">+</button>
                            <span style="margin-left: auto; font-size: 11px; color: #9ca3af;">不透明度</span>
                        </div>
                        <div class="av-adjust-info">
                            <span>📋 当前字幕: ${state.subtitleData.length > 0 ? state.subtitleData.length + ' 条' : '未加载'}</span>
                            <button id="av-clear-subtitle" class="av-clear-btn" style="margin-left: auto; background:#ef4444; border:none; border-radius:6px; padding:4px 12px; color:white; cursor:pointer; font-size:11px;">🗑️ 清除</button>
                        </div>
                    </div>
                </div>

                <!-- 字幕搜索区 -->
                <div class="av-section">
                    <div class="av-section-header" id="av-subtitle-search-header">
                        <span>🔍 字幕搜索</span>
                        <span class="av-toggle-icon">▼</span>
                    </div>
                    <div class="av-section-content" id="av-subtitle-search-content">
                        <div class="av-search-row">
                            <input type="text" id="av-search-input" placeholder="输入番号或关键词（自动识别）">
                            <button id="av-search-btn" class="av-primary-btn">🔍 搜索</button>
                        </div>
                        <div class="av-subtitle-filter-row">
                            <label><input type="checkbox" id="av-chinese-only" ${getSubtitleChineseOnly() ? 'checked' : ''}> 只显示含中文字幕</label>
                            <span id="av-language-check-hint">结果会读取字幕正文判断语言</span>
                        </div>
                        <div id="av-result-list" class="av-result-list"></div>
                        <div class="av-hint">💡 提示：支持迅雷字幕搜索，自动识别番号</div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        // CSS样式
        const style = document.createElement('style');
        style.textContent = `
            /* 恢复按钮样式 */
            #av-restore-btn {
                position: fixed; right: 0; top: 50%; transform: translateY(-50%);
                width: 44px; height: 44px; background: linear-gradient(135deg, #4f46e5, #7c3aed);
                border-radius: 8px 0 0 8px; display: flex; align-items: center; justify-content: center;
                cursor: pointer; z-index: 999999; font-size: 22px; color: white;
                transition: all 0.3s; box-shadow: -2px 0 10px rgba(0,0,0,0.3);
                user-select: none; visibility: visible !important; opacity: 1 !important;
            }
            /* 不依赖宿主网页的 .hidden，避免入口被站点样式误隐藏。 */
            #av-restore-btn:not(.hidden) { display: flex !important; }
            #av-restore-btn:hover { width: 52px; }
            #av-restore-btn.active { background: linear-gradient(135deg, #4f46e5, #22c55e); }
            #av-restore-btn.dragging { transition: none !important; opacity: 0.8; cursor: grabbing; }

            /* 主面板样式 */
            #av-main-panel {
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                width: min(420px, 90vw); max-width: 90vw;
                background: #1f2937; color: #e5e7eb; border-radius: 16px;
                box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); z-index: 999999;
                display: flex; flex-direction: column; max-height: 85vh; overflow: hidden;
                backdrop-filter: blur(2px);
            }
            #av-main-panel.hidden { display: none !important; }
            #av-main-panel:not(.hidden) { display: flex !important; visibility: visible !important; }

            /* 移动端适配 */
            @media (max-width: 768px) {
                #av-main-panel { top: auto; bottom: 20px; left: 50%; transform: translateX(-50%); width: 92vw; max-height: 80vh; border-radius: 20px; }
                #av-restore-btn { right: 10px; top: auto; bottom: 80px; transform: none; width: 48px; height: 48px; border-radius: 50%; font-size: 24px; }
                #av-restore-btn:hover { width: 48px; }
            }
            @media (max-width: 480px) {
                #av-main-panel { width: 95vw; bottom: 10px; max-height: 85vh; border-radius: 16px; }
                #av-restore-btn { right: 8px; bottom: 70px; width: 44px; height: 44px; font-size: 22px; }
                .av-section-header { padding: 10px 12px; font-size: 12px; }
                .av-section-content { padding: 10px; }
                .av-control-row { gap: 8px; margin-bottom: 10px; }
                .av-seek-btn, #av-play-pause, .av-speed-btn, .av-global-btn { padding: 5px 10px; font-size: 11px; }
                .av-search-row { gap: 8px; }
                #av-search-input { padding: 8px 12px; font-size: 12px; flex:1; }
                .av-primary-btn { padding: 8px 14px; font-size: 12px; }
                .av-adjust-row { gap: 8px; }
                .av-adjust-row span { font-size: 12px; }
                .av-offset-btn, .av-size-btn { width: 28px; height: 28px; font-size: 12px; }
            }

            /* 横屏模式 */
            @media (max-width: 896px) and (orientation: landscape) {
                #av-main-panel { max-height: 90vh; top: 50%; bottom: auto; transform: translate(-50%, -50%); width: 65vw; }
            }

            /* 桌面端大屏幕优化 */
            @media (min-width: 1200px) {
                #av-main-panel { width: 440px; max-width: 440px; }
                .av-panel-body { max-height: 70vh; }
            }

            .av-panel-header {
                padding: 14px 18px; background: #374151; border-radius: 16px 16px 0 0;
                display: flex; justify-content: space-between; align-items: center;
                cursor: move; user-select: none; font-weight: bold; font-size: 15px;
            }
            .av-panel-header:active { cursor: grabbing; }
            .av-panel-header button { background: none; border: none; color: white; font-size: 22px; cursor: pointer; padding: 0 8px; }
            .av-panel-header button:hover { color: #ef4444; }

            .av-panel-body { padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; flex: 1; }

            .av-section {
                background: #374151;
                border-radius: 12px;
                overflow: hidden;
            }
            .av-section-header {
                padding: 12px 14px;
                background: #4b5563;
                font-weight: 600;
                font-size: 13px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: background 0.2s;
            }
            .av-section-header:hover {
                background: #5b6b7b;
            }
            .av-toggle-icon {
                font-size: 12px;
                transition: transform 0.3s;
            }
            .av-section-content {
                padding: 12px;
                transition: all 0.3s ease;
            }
            .av-section-content.collapsed {
                display: none;
            }

            .av-control-row { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
            .av-control-row:last-child { margin-bottom: 0; }
            .av-seek-btn, #av-play-pause, .av-speed-btn, .av-global-btn {
                background: #4b5563; border: none; color: white; padding: 6px 14px;
                border-radius: 8px; cursor: pointer; font-size: 12px;
                transition: all 0.2s;
            }
            .av-seek-btn:hover, .av-speed-btn:hover, .av-global-btn:hover {
                background: #6b7280;
                transform: translateY(-1px);
            }
            #av-play-pause { background: linear-gradient(135deg, #4f46e5, #7c3aed); font-weight: bold; }
            #av-play-pause:hover { transform: translateY(-1px); box-shadow: 0 2px 8px rgba(79,70,229,0.3); }
            .av-speed-btn, .av-global-btn { background: #6b7280; }
            .av-global-btn.active { background: #22c55e; }
            .av-global-btn.active:hover { background: #16a34a; }
            #av-volume-slider { width: 100px; height: 4px; cursor: pointer; background: #4b5563; border-radius: 2px; }

            /* 字幕调整区域样式 */
            .av-adjust-row {
                display: flex;
                gap: 10px;
                align-items: center;
                margin-bottom: 12px;
                flex-wrap: wrap;
            }
            .av-adjust-row:last-child {
                margin-bottom: 0;
            }
            .av-adjust-row span {
                font-size: 13px;
            }
            .av-adjust-info {
                display: flex;
                align-items: center;
                justify-content: space-between;
                font-size: 12px;
                color: #9ca3af;
                padding-top: 8px;
                margin-top: 4px;
                border-top: 1px solid #4b5563;
            }

            .av-toggle-switch { width: 40px; height: 22px; background: #6b7280; border-radius: 11px; cursor: pointer; position: relative; transition: background 0.2s; }
            .av-toggle-switch.active { background: #4f46e5; }
            .av-toggle-slider { width: 18px; height: 18px; background: white; border-radius: 50%; position: absolute; top: 2px; left: 2px; transition: transform 0.2s; }
            .av-toggle-switch.active .av-toggle-slider { transform: translateX(18px); }

            .av-offset-btn, .av-size-btn { width: 32px; height: 32px; background: #4b5563; border: none; border-radius: 8px; color: white; cursor: pointer; font-size: 14px; transition: all 0.2s; }
            .av-offset-btn:hover, .av-size-btn:hover { background: #6b7280; transform: translateY(-1px); }
            .av-reset-btn { background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 11px; padding: 4px 8px; }
            .av-reset-btn:hover { color: #fbbf24; }
            .av-clear-btn:hover { background: #dc2626 !important; transform: translateY(-1px); }

            #av-style-select { background: #374151; color: white; border: 1px solid #6b7280; border-radius: 6px; padding: 6px 8px; font-size: 12px; cursor: pointer; }

            .av-search-row { display: flex; gap: 10px; margin-bottom: 12px; }
            .av-subtitle-filter-row { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:0 0 8px; color:#cbd5e1; font-size:11px; }
            .av-subtitle-filter-row label { display:flex; align-items:center; gap:5px; cursor:pointer; }
            .av-subtitle-filter-row input { accent-color:#4f46e5; }
            #av-language-check-hint { color:#94a3b8; }
            #av-search-input { flex: 1; background: #374151; border: 1px solid #6b7280; border-radius: 10px; padding: 10px 14px; color: white; font-size: 13px; }
            #av-search-input:focus { outline: none; border-color: #4f46e5; box-shadow: 0 0 0 2px rgba(79,70,229,0.2); }
            .av-primary-btn { background: linear-gradient(135deg, #4f46e5, #7c3aed); border: none; border-radius: 10px; padding: 10px 20px; color: white; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.2s; }
            .av-primary-btn:hover { transform: translateY(-1px); box-shadow: 0 2px 8px rgba(79,70,229,0.3); }

            .av-result-list { max-height: 280px; overflow-y: auto; background: #374151; border-radius: 12px; display: none; width: 100%; margin-top: 8px; }
            .av-result-list.show { display: block; }
            .av-result-list::-webkit-scrollbar { width: 6px; }
            .av-result-list::-webkit-scrollbar-track { background: #4b5563; border-radius: 3px; }
            .av-result-list::-webkit-scrollbar-thumb { background: #4f46e5; border-radius: 3px; }
            .av-result-item { padding: 10px 12px; cursor: pointer; border-bottom: 1px solid #4b5563; display: flex; gap: 10px; align-items: center; transition: background 0.2s; }
            .av-result-item:hover { background: #4b5563; }
            .av-result-item.selected { background: #4f46e5; outline: 2px solid #a5b4fc; outline-offset: -2px; }
            .av-result-source { font-size: 11px; color: #9ca3af; min-width: 45px; flex-shrink: 0; display:flex; flex-direction:column; gap:3px; }
            .av-language-badge { display:inline-block; width:max-content; padding:1px 4px; border-radius:4px; font-size:9px; line-height:1.2; font-weight:700; }
            .av-language-badge.chinese { background:#166534; color:#bbf7d0; }
            .av-language-badge.non-chinese { background:#475569; color:#cbd5e1; }
            .av-language-badge.checking { background:#854d0e; color:#fef08a; }
            .av-language-badge.unknown { background:#7f1d1d; color:#fecaca; }
            .av-result-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e5e7eb; }
            .av-mini-btn { background: #4b5563; border: none; border-radius: 8px; padding: 4px 10px; color: white; cursor: pointer; font-size: 11px; flex-shrink: 0; transition: all 0.2s; }
            .av-mini-btn:hover { background: #6b7280; transform: translateY(-1px); }
            .av-search-cache-note { padding: 7px 12px; color: #93c5fd; background: #26364d; font-size: 11px; border-bottom: 1px solid #4b5563; }
            .av-loading, .av-empty { padding: 24px; text-align: center; color: #9ca3af; font-size: 13px; }
            .av-loading::before { content: "⏳"; margin-right: 8px; }
            .av-empty::before { content: "📭"; margin-right: 8px; }

            .av-hint { font-size: 10px; color: #6b7280; margin-top: 10px; text-align: center; }

            /* 列表页字幕探测小黄标 */
            .av-subtitle-badge {
                position: absolute; top: 8px; right: 8px; z-index: 10;
                padding: 3px 7px; font-size: 10px; border-radius: 4px;
                color: white; font-weight: bold; pointer-events: none;
                box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            }

            /* 字幕列表弹窗 */
            .av-subtitle-list {
                position: fixed; background: #1f2937; color: white;
                max-height: 70vh; max-width: 90vw; min-width: 250px;
                width: auto; overflow-y: auto; overflow-x: hidden;
                padding: 14px; border-radius: 16px; z-index: 1000000;
                border: 1px solid #4b5563; box-shadow: 0 8px 30px rgba(0,0,0,0.4);
            }
            @media (max-width: 768px) {
                .av-subtitle-list {
                    max-width: 85vw; min-width: 280px;
                    left: 50% !important; transform: translateX(-50%);
                    bottom: auto !important; top: 50% !important;
                    transform: translate(-50%, -50%); max-height: 80vh;
                }
            }
            .av-list-title {
                padding: 8px 12px; border-bottom: 2px solid #4f46e5;
                margin-bottom: 12px; font-size: 14px; font-weight: bold;
                color: #e5e7eb; display: flex; justify-content: space-between;
                align-items: center;
            }
            .av-list-close {
                cursor: pointer; padding: 4px 10px; background: #4b5563;
                border-radius: 6px; font-size: 12px;
            }
            .av-list-close:hover { background: #ef4444; }
            .av-list-item {
                padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #374151;
                display: flex; justify-content: space-between; align-items: center;
                font-size: 12px; gap: 14px; border-radius: 8px; margin: 4px 0;
            }
            .av-list-item:hover { background: #374151; }
            .av-list-item.selected { background: #4f46e5; outline: 2px solid #a5b4fc; outline-offset: -2px; }
            .av-list-item-info { flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 3px; }
            .av-list-item-source { font-size: 10px; color: #9ca3af; }
            .av-list-item-name { font-size: 12px; color: #e5e7eb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .av-dl-btn {
                background: linear-gradient(135deg, #4f46e5, #7c3aed);
                border: none; border-radius: 8px; padding: 5px 14px;
                color: white; cursor: pointer; font-size: 11px;
                font-weight: 600; flex-shrink: 0; transition: all 0.2s;
            }
            .av-dl-btn:hover { transform: scale(1.02); }
            .av-sub-action-group { display:flex; align-items:center; gap:5px; flex-shrink:0; }
            .av-115-sub-btn { background:#0ea5e9; border:0; border-radius:8px; padding:5px 10px; color:#082f49; cursor:pointer; font-size:11px; font-weight:700; }
            .av-115-sub-btn:hover { background:#38bdf8; }
            .av-115-sub-btn:disabled, .av-save-115:disabled { opacity:.55; cursor:wait; }

            .av-subtitle-preview { position:fixed; z-index:1000001; left:50%; top:8%; transform:translateX(-50%); width:min(850px,90vw); height:75vh; background:#111827; color:#e5e7eb; border:1px solid #4b5563; border-radius:12px; padding:12px; box-shadow:0 8px 30px rgba(0,0,0,.5); } .av-preview-head { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #4b5563; padding-bottom:8px; margin-bottom:8px; } .av-preview-head button { background:#ef4444; color:#fff; border:0; border-radius:6px; padding:5px 10px; cursor:pointer; } .av-subtitle-preview pre { height:calc(100% - 40px); overflow:auto; white-space:pre-wrap; font:12px/1.5 monospace; margin:0; }
            #av-toast {
                position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
                background: rgba(0,0,0,0.85); color: white; padding: 10px 18px;
                border-radius: 10px; z-index: 9999999; font-size: 13px;
                max-width: 85vw; word-break: break-word; pointer-events: none;
                transition: opacity 0.3s; white-space: nowrap; backdrop-filter: blur(8px);
            }
            @media (max-width: 480px) {
                .av-subtitle-preview { position:fixed; z-index:1000001; left:50%; top:8%; transform:translateX(-50%); width:min(850px,90vw); height:75vh; background:#111827; color:#e5e7eb; border:1px solid #4b5563; border-radius:12px; padding:12px; box-shadow:0 8px 30px rgba(0,0,0,.5); } .av-preview-head { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #4b5563; padding-bottom:8px; margin-bottom:8px; } .av-preview-head button { background:#ef4444; color:#fff; border:0; border-radius:6px; padding:5px 10px; cursor:pointer; } .av-subtitle-preview pre { height:calc(100% - 40px); overflow:auto; white-space:pre-wrap; font:12px/1.5 monospace; margin:0; }
            #av-toast { bottom: 15px; padding: 8px 14px; font-size: 12px;
                max-width: 90vw; white-space: normal; text-align: center; }
            }
        `;
        document.head.appendChild(style);

        // 面板拖拽
        let isDragging = false;
        let dragStartX = 0, dragStartY = 0;
        let panelStartLeft = 0, panelStartTop = 0;
        let wasCentered = true;

        const panelHeader = panel.querySelector('.av-panel-header');

        const savedPanelLeft = localStorage.getItem('av-panel-left');
        const savedPanelTop = localStorage.getItem('av-panel-top');
        if (savedPanelLeft && savedPanelTop) {
            panel.style.left = savedPanelLeft + 'px';
            panel.style.top = savedPanelTop + 'px';
            panel.style.transform = 'none';
            wasCentered = false;
        }

        panelHeader.addEventListener('mousedown', (e) => {
            if (e.target.closest('#av-minimize')) return;
            isDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;

            const rect = panel.getBoundingClientRect();

            if (wasCentered) {
                panelStartLeft = rect.left;
                panelStartTop = rect.top;
                panel.style.left = panelStartLeft + 'px';
                panel.style.top = panelStartTop + 'px';
                panel.style.transform = 'none';
                wasCentered = false;
            } else {
                panelStartLeft = rect.left;
                panelStartTop = rect.top;
            }

            panel.style.transition = 'none';
            panel.style.cursor = 'grabbing';
            panelHeader.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            let newLeft = panelStartLeft + (e.clientX - dragStartX);
            let newTop = panelStartTop + (e.clientY - dragStartY);

            const maxLeft = window.innerWidth - panel.offsetWidth;
            const maxTop = window.innerHeight - panel.offsetHeight;
            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));

            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            panel.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                panel.style.transition = '';
                panel.style.cursor = '';
                panelHeader.style.cursor = 'move';

                if (panel.style.left && panel.style.top) {
                    localStorage.setItem('av-panel-left', parseInt(panel.style.left));
                    localStorage.setItem('av-panel-top', parseInt(panel.style.top));
                }
            }
        });

        panelHeader.style.cursor = 'move';

        // 绑定UI事件
        document.getElementById('av-minimize').onclick = () => {
            panel.classList.add('hidden');
            restoreBtn.classList.remove('hidden');
        };

        document.getElementById('av-play-pause').onclick = () => {
            const video = state.currentVideo;
            if (!video) return showToast('未选择视频');
            if (video.paused) video.play();
            else video.pause();
        };

        document.querySelectorAll('.av-seek-btn').forEach(btn => {
            btn.onclick = () => {
                const video = state.currentVideo;
                if (!video) return showToast('未选择视频');
                const sec = parseInt(btn.dataset.seek);
                video.currentTime += sec;
                showToast(`${sec > 0 ? '前进' : '后退'} ${Math.abs(sec)}秒`);
            };
        });

        document.getElementById('av-volume-slider').oninput = (e) => {
            state.currentVolume = parseFloat(e.target.value);
            if (state.currentVideo) state.currentVideo.volume = state.currentVolume;
            updateVolumeDisplay();
        };

        document.getElementById('av-speed-toggle').onclick = () => {
            const speeds = [1, 1.5, 2, 3, 4, 5, 6, 8, 10];
            const currentIdx = speeds.indexOf(state.currentSpeed);
            const nextIdx = (currentIdx + 1) % speeds.length;
            state.currentSpeed = speeds[nextIdx];
            updateSpeedDisplay();
            document.getElementById('av-speed-toggle').textContent = state.currentSpeed + 'x';
            if (state.currentVideo && !state.currentVideo.paused) state.currentVideo.playbackRate = state.currentSpeed;
            showToast(`播放速度：${state.currentSpeed}x`);
        };

        document.getElementById('av-global-toggle').onclick = () => {
            toggleGlobalSpeed();
            document.getElementById('av-global-toggle').classList.toggle('active', state.isAccelerating);
        };

        // 字幕调整事件
        document.getElementById('av-zimu-toggle').onclick = toggleSubtitle;
        document.getElementById('av-offset-minus').onclick = () => adjustOffset(-0.5);
        document.getElementById('av-offset-plus').onclick = () => adjustOffset(0.5);
        document.getElementById('av-offset-reset').onclick = () => adjustOffset(0, true);

        document.getElementById('av-font-minus').onclick = () => {
            changeFontSize(-2);
            document.getElementById('av-font-size').textContent = state.subtitleFontSize + 'px';
        };
        document.getElementById('av-font-plus').onclick = () => {
            changeFontSize(2);
            document.getElementById('av-font-size').textContent = state.subtitleFontSize + 'px';
        };

        document.getElementById('av-bg-minus').onclick = () => {
            changeBgOpacity(-0.1);
            document.getElementById('av-bg-opacity-value').textContent = Math.round(state.subtitleBgOpacity * 100) + '%';
        };
        document.getElementById('av-bg-plus').onclick = () => {
            changeBgOpacity(0.1);
            document.getElementById('av-bg-opacity-value').textContent = Math.round(state.subtitleBgOpacity * 100) + '%';
        };

        document.getElementById('av-style-select').onchange = (e) => changeStyle(e.target.value);

        document.getElementById('av-clear-subtitle').onclick = clearSubtitle;

        // 字幕搜索事件
        document.getElementById('av-search-btn').onclick = searchSubtitle;
        document.getElementById('av-search-input').onkeypress = (e) => { if (e.key === 'Enter') searchSubtitle(); };
        document.getElementById('av-chinese-only').onchange = (e) => {
            setSubtitleChineseOnly(e.target.checked)
            if (subtitleSearchRefresh) subtitleSearchRefresh()
        };

        // 初始化折叠面板
        initCollapsibleSections();

        updateSpeedDisplay();
        updateVolumeDisplay();
        setTimeout(autoFillSearchBox, 500);
        setTimeout(() => autoOpenAndSearchSubtitle(0), 800);

        // 定时更新字幕状态显示
        setInterval(() => {
            const infoSpan = document.querySelector('#av-subtitle-adjust-content .av-adjust-info span');
            if (infoSpan) {
                infoSpan.innerHTML = `📋 当前字幕: ${state.subtitleData.length > 0 ? state.subtitleData.length + ' 条' : '未加载'}`;
            }
            const offsetSpan = document.getElementById('av-offset-value');
            if (offsetSpan) {
                offsetSpan.textContent = `${state.subtitleOffset > 0 ? '+' : ''}${state.subtitleOffset.toFixed(1)}s`;
            }
            const fontSizeSpan = document.getElementById('av-font-size');
            if (fontSizeSpan) {
                fontSizeSpan.textContent = state.subtitleFontSize + 'px';
            }
            const bgSpan = document.getElementById('av-bg-opacity-value');
            if (bgSpan) {
                bgSpan.textContent = Math.round(state.subtitleBgOpacity * 100) + '%';
            }
            const toggle = document.getElementById('av-zimu-toggle');
            if (toggle) {
                toggle.classList.toggle('active', state.subtitleEnabled);
            }
        }, 1000);
    }

    // ==================== 视频选择初始化 ====================
    function initVideoSelection() {
        const scanVideos = () => {
            const videos = Array.from(document.querySelectorAll('video')).filter(canBeControlled);
            autoSelectSingleVideo();

            videos.forEach(video => {
                if (!video.dataset.avInitialized) {
                    video.dataset.avInitialized = 'true';
                    installBackgroundPlaybackGuard(video);
                    video.addEventListener('play', () => {
                        if (!state.currentVideo) switchToVideo(video);
                        if (state.isAccelerating && video.playbackRate !== state.currentSpeed) {
                            video.playbackRate = state.currentSpeed;
                        }
                    }, true);
                    video.addEventListener('click', () => switchToVideo(video), true);
                }
            });
        };

        scanVideos();
        setInterval(scanVideos, 2000);

        const observer = new MutationObserver(() => scanVideos());
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ==================== 主入口 ====================
    let initialized = false;

    function is115UserPageForVideoAssistant() {
        return /^(?:www\.)?115\.com$/i.test(location.hostname)
    }

    function main() {
        if (initialized) return;
        initialized = true;

        // 115页面由“本地同步”侧边栏接管，不再显示视频控制/字幕搜索侧边栏。
        if (is115UserPageForVideoAssistant()) return;

        createPanel();
        initVideoSelection();
        initListPageDiscovery();
        enableGlobalSpeed(CONFIG.DEFAULT_SPEED);
        showToast('视频助手已加载（5倍速全局加速）');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        setTimeout(main, 500);
    }

    window.addEventListener('beforeunload', () => {
        if (globalSpeedInterval) clearInterval(globalSpeedInterval);
    });
})();
