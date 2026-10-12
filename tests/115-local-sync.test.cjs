const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const scriptPath = process.env.SCRIPT_UNDER_TEST || path.resolve(__dirname, '../视频字幕一体助手.user.js')
const source = fs.readFileSync(scriptPath, 'utf8')

function getDeclaration(name) {
    const startPattern = new RegExp('^    (?:async )?function ' + name + '\\(', 'm')
    const start = source.search(startPattern)
    assert.notEqual(start, -1, 'Missing function ' + name)
    const tail = source.slice(start + 1)
    const nextPattern = /^    (?:async )?function [A-Za-z_$][\w$]*\(/gm
    const next = nextPattern.exec(tail)
    return source.slice(start, next ? start + 1 + next.index : source.length)
}

function getConstant(name) {
    const pattern = new RegExp('^    const ' + name + ' = .*$', 'm')
    const match = source.match(pattern)
    assert.ok(match, 'Missing constant ' + name)
    return match[0]
}

const declarations = [
    getConstant('LOCAL_SYNC_CODE_RE'),
    getConstant('LOCAL_SYNC_NUMBER_PAIR_RE'),
    getConstant('LOCAL_SYNC_NUMBER_RE'),
    getDeclaration('normalizeLocalSyncCode'),
    getDeclaration('extractLocalSyncCodeFromName'),
    getDeclaration('get115SearchKeywords'),
    getDeclaration('get115FileNameKey'),
    getDeclaration('find115LocalSyncRemoteByRecord'),
    getDeclaration('find115LocalSyncMatches'),
    getDeclaration('applyLocalSyncRemoteToSameName'),
    getDeclaration('getLocalSyncFolderName'),
    getDeclaration('find115LocalSyncVideoFolder'),
    getDeclaration('find115FolderByName'),
    getDeclaration('find115TopLevelCloudDownloadFolder'),
    getDeclaration('ensure115LocalSyncFolder'),
    getDeclaration('resolve115LocalSyncFolder')
].join('\n')

const syncStart = source.indexOf('        const syncItems = async items => {')
const syncEnd = source.indexOf('        state.scanAndRender = async () => {', syncStart)
assert.ok(syncStart >= 0 && syncEnd > syncStart, 'Missing local sync action')
const syncAction = source.slice(syncStart, syncEnd)

const context = vm.createContext({ URLSearchParams })
vm.runInContext(`
    const folderChildren = new Map()
    const folderCreateCalls = []
    let remoteSearchItems = []
    async function query115LocalSyncRemoteFiles() {
        return remoteSearchItems
    }
    function setRemoteSearchItems(items) {
        remoteSearchItems = items
    }
    async function request115FolderChildren(cid) {
        return folderChildren.get(String(cid)) || []
    }
    async function request115JsonWithPageFallback(method, url, body) {
        const params = new URLSearchParams(body)
        const parentCid = params.get('pid')
        const name = params.get('cname')
        folderCreateCalls.push({ parentCid, name })
        const cid = 'created-' + folderCreateCalls.length
        folderChildren.set(parentCid, (folderChildren.get(parentCid) || []).concat({
            folderCid: cid, name, isFolder: true
        }))
        return { data: { cid } }
    }
    function get115FolderCidFromPayload(payload) {
        return String(payload && payload.data && payload.data.cid || '')
    }
` + declarations + `
    async function runSyncItems(matches, targetCid) {
        const uploads = []
        const state = {
            directories: [{}], matches, folderPromises: new Map(), syncing: false,
            renderCurrent() {}, setStatusCurrent(message, level) {
                state.message = message
                state.level = level
            }
        }
        const targetInput = { value: targetCid }
        const updateButtons = () => {}
        const isItemExcluded = item => Boolean(item.excluded)
        const saveLocalSyncTargetCid = () => true
        const notifyLocalSyncChanged = () => {}
        const find115FileInFolder = async () => null
        const uploadLocalSyncFile = async (item, cid) => {
            uploads.push({ name: item.record.name, cid })
            return { name: item.record.name, parentCid: cid, isVideo: item.record.kind === 'video' }
        }
` + syncAction + `
        await syncItems(matches)
        return { uploads, matches, message: state.message, level: state.level }
    }
    globalThis.api = {
        folderChildren,
        folderCreateCalls,
        normalizeLocalSyncCode,
        extractLocalSyncCodeFromName,
        get115SearchKeywords,
        find115LocalSyncRemoteByRecord,
        find115LocalSyncMatches,
        runSyncItems,
        setRemoteSearchItems,
        getLocalSyncFolderName,
        find115LocalSyncVideoFolder,
        ensure115LocalSyncFolder,
        resolve115LocalSyncFolder
    }
`, context)

const api = context.api
const localVideos = [
    { kind: 'video', name: '030413-279 義母の筆下ろし教育 1.wmv' },
    { kind: 'video', name: '030413-279 義母の筆下ろし教育 2.wmv' },
    { kind: 'subtitle', name: '030413-279 義母の筆下ろし教育 1.srt' },
    { kind: 'subtitle', name: '030413-279 義母の筆下ろし教育 2.srt' }
]

test('keeps numeric hyphenated numbers intact for parsing and search', () => {
    assert.equal(api.extractLocalSyncCodeFromName(localVideos[0].name), '030413-279')
    assert.deepEqual(JSON.parse(JSON.stringify(api.get115SearchKeywords('030413-279'))), {
        exact: '030413-279', fallback: '030413 279', display: '030413-279'
    })
})

test('does not let a remote video or another episode satisfy a subtitle/video row', () => {
    const remoteVideos = [
        { name: localVideos[0].name, isVideo: true, isFolder: false, parentCid: '70', sizeBytes: 900 },
        { name: localVideos[1].name, isVideo: true, isFolder: false, parentCid: '70', sizeBytes: 800 }
    ]
    assert.equal(api.find115LocalSyncRemoteByRecord(remoteVideos, localVideos[2]), null)
    assert.equal(api.find115LocalSyncRemoteByRecord(remoteVideos.slice(0, 1), localVideos[1]), null)
    assert.equal(api.find115LocalSyncRemoteByRecord(remoteVideos, localVideos[0]).name, localVideos[0].name)
})

test('marks both remote WMVs as existing while keeping both missing SRT rows pending', async () => {
    api.setRemoteSearchItems([
        { name: localVideos[0].name, isVideo: true, isFolder: false, parentCid: '70', sizeBytes: 900 },
        { name: localVideos[1].name, isVideo: true, isFolder: false, parentCid: '70', sizeBytes: 800 }
    ])
    const records = localVideos.map(record => ({ ...record, code: '030413-279' }))
    const results = await api.find115LocalSyncMatches(records)
    const byName = new Map(results.map(item => [item.record.name, [item.record.kind, item.status]]))
    assert.deepEqual(byName.get(localVideos[0].name), ['video', 'exists'])
    assert.deepEqual(byName.get(localVideos[1].name), ['video', 'exists'])
    assert.deepEqual(byName.get(localVideos[2].name), ['subtitle', 'pending'])
    assert.deepEqual(byName.get(localVideos[3].name), ['subtitle', 'pending'])
})

test('uses the shared video title without its trailing episode number as folder name', () => {
    assert.equal(api.getLocalSyncFolderName(localVideos, '030413-279'), '030413-279 義母の筆下ろし教育')
})

test('reuses the existing non-root directory containing the matching remote video', async () => {
    const remoteVideos = [
        { name: localVideos[0].name, isVideo: true, isFolder: false, parentCid: '70' },
        { name: localVideos[1].name, isVideo: true, isFolder: false, parentCid: '70' }
    ]
    assert.equal(await api.resolve115LocalSyncFolder('030413-279', localVideos, remoteVideos, '0'), '70')
    assert.equal(api.folderCreateCalls.length, 0)
})

test('creates a numbered folder only below the top-level cloud-download folder', async () => {
    api.folderChildren.set('0', [{ folderCid: '10', name: '云下载', isFolder: true }])
    api.folderChildren.set('10', [])
    const cid = await api.resolve115LocalSyncFolder('030413-279', localVideos, [], '10')
    assert.equal(cid, 'created-1')
    assert.deepEqual(JSON.parse(JSON.stringify(api.folderCreateCalls[0])), {
        parentCid: '10', name: '030413-279 義母の筆下ろし教育'
    })
})

test('reuses a same-number folder already under cloud downloads', async () => {
    api.folderChildren.set('0', [{ folderCid: '10', name: '云下载', isFolder: true }])
    api.folderChildren.set('10', [{ folderCid: '11', name: '030413-279 旧标题', isFolder: true }])
    const before = api.folderCreateCalls.length
    assert.equal(await api.resolve115LocalSyncFolder('030413-279', localVideos, [], '10'), '11')
    assert.equal(api.folderCreateCalls.length, before)
})

test('uses another existing non-root target directly and rejects root creation', async () => {
    api.folderChildren.set('0', [])
    api.folderChildren.set('20', [])
    const before = api.folderCreateCalls.length
    assert.equal(await api.resolve115LocalSyncFolder('030413-279', localVideos, [], '20'), '20')
    assert.equal(api.folderCreateCalls.length, before)
    await assert.rejects(api.resolve115LocalSyncFolder('030413-279', localVideos, [], '0'), /根目录/)
    await assert.rejects(api.ensure115LocalSyncFolder('0', '030413-279 title'), /禁止在115根目录创建/)
    await assert.rejects(api.ensure115LocalSyncFolder('20', '030413-279 title'), /只能在.*云下载/)
})

test('places missing subtitles in a numbered child when the remote videos are directly in cloud downloads', async () => {
    api.folderChildren.set('0', [{ folderCid: '10', name: '云下载', isFolder: true }])
    api.folderChildren.set('10', [])
    api.setRemoteSearchItems(localVideos.slice(0, 2).map(record => ({
        name: record.name, isVideo: true, isFolder: false, parentCid: '10'
    })))
    const before = api.folderCreateCalls.length
    const matches = await api.find115LocalSyncMatches(localVideos.map(record => ({ ...record, code: '030413-279' })))
    const result = await api.runSyncItems(matches, '')
    assert.equal(result.level, 'ok', result.message)
    assert.equal(api.folderCreateCalls.length, before + 1)
    assert.equal(api.folderCreateCalls[before].parentCid, '10')
    assert.deepEqual(Array.from(result.uploads, item => item.name), localVideos.slice(2).map(record => record.name))
    assert.ok(result.uploads.every(item => item.cid === 'created-' + (before + 1)))
    assert.ok(result.matches.every(item => item.exists))
})

test('syncs a missing subtitle to the existing video parent without requiring a target CID', async () => {
    api.folderChildren.set('0', [{ folderCid: '10', name: '云下载', isFolder: true }])
    api.setRemoteSearchItems([{ name: localVideos[0].name, isVideo: true, isFolder: false, parentCid: '70' }])
    const before = api.folderCreateCalls.length
    const matches = await api.find115LocalSyncMatches([localVideos[2]].map(record => ({ ...record, code: '030413-279' })))
    const result = await api.runSyncItems(matches, '')
    assert.equal(result.level, 'ok', result.message)
    assert.equal(result.uploads.length, 1)
    assert.equal(result.uploads[0].cid, '70')
    assert.equal(api.folderCreateCalls.length, before)
})

test('automatically uses top-level cloud downloads when no target or remote parent is available', async () => {
    api.folderChildren.set('0', [{ folderCid: '10', name: '云下载', isFolder: true }])
    api.folderChildren.set('10', [])
    const before = api.folderCreateCalls.length
    assert.equal(await api.resolve115LocalSyncFolder('030413-279', localVideos, [], ''), 'created-' + (before + 1))
    assert.equal(api.folderCreateCalls[before].parentCid, '10')
})

test('refuses an unknown default destination and never creates under a nested folder named cloud downloads', async () => {
    api.folderChildren.set('0', [])
    api.folderChildren.set('20', [{ folderCid: '21', name: '云下载', isFolder: true }])
    const before = api.folderCreateCalls.length
    await assert.rejects(api.resolve115LocalSyncFolder('030413-279', localVideos, [], ''), /云下载/)
    await assert.rejects(api.ensure115LocalSyncFolder('21', '030413-279 title'), /只能在.*云下载/)
    assert.equal(api.folderCreateCalls.length, before)
})

test('uses the remote video title for a new cloud-download child when only local subtitles are selected', async () => {
    api.folderChildren.set('0', [{ folderCid: '10', name: '云下载', isFolder: true }])
    api.folderChildren.set('10', [])
    const remoteVideos = localVideos.slice(0, 2).map(record => ({
        name: record.name, isVideo: true, isFolder: false, parentCid: '10'
    }))
    const before = api.folderCreateCalls.length
    const cid = await api.resolve115LocalSyncFolder('030413-279', localVideos.slice(2), remoteVideos, '20')
    assert.equal(cid, 'created-' + (before + 1))
    assert.equal(api.folderCreateCalls[before].parentCid, '10')
    assert.equal(api.folderCreateCalls[before].name, '030413-279 義母の筆下ろし教育')
})

test('blocks an explicitly selected root CID before creating a folder or uploading a file', async () => {
    const before = api.folderCreateCalls.length
    const matches = [{ record: { ...localVideos[2], code: '030413-279' }, exists: false, status: 'pending' }]
    const result = await api.runSyncItems(matches, '0')
    assert.equal(result.level, 'error')
    assert.match(result.message, /根目录/)
    assert.equal(result.uploads.length, 0)
    assert.equal(api.folderCreateCalls.length, before)
})
