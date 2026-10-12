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
    getDeclaration('getLocalSyncFolderName'),
    getDeclaration('find115LocalSyncVideoFolder'),
    getDeclaration('find115FolderByName'),
    getDeclaration('find115TopLevelCloudDownloadFolder'),
    getDeclaration('ensure115LocalSyncFolder'),
    getDeclaration('resolve115LocalSyncFolder')
].join('\n')

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
    globalThis.api = {
        folderChildren,
        folderCreateCalls,
        normalizeLocalSyncCode,
        extractLocalSyncCodeFromName,
        get115SearchKeywords,
        find115LocalSyncRemoteByRecord,
        find115LocalSyncMatches,
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
