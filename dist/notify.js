"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.apply = apply;
const koishi_1 = require("koishi");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const cfmr_1 = require("./cfmr");
const fetch = require('node-fetch');
const MR_BASE = 'https://api.modrinth.com/v2';
const CF_MIRROR_BASE = 'https://api.curse.tools/v1/cf';
function normalizePlatform(platform) {
    if (platform === 'mr' || platform === 'cf')
        return platform;
    return null;
}
async function toImageSrc(input) {
    const value = (input && typeof input.then === 'function') ? await input : input;
    if (!value)
        return '';
    if (typeof value === 'string')
        return value;
    const buf = Buffer.isBuffer(value) ? value : (value instanceof Uint8Array ? Buffer.from(value) : null);
    if (buf)
        return `data:image/png;base64,${buf.toString('base64')}`;
    return String(value);
}
async function fetchJson(url, timeout = 15000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: controller.signal });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return await res.json();
    }
    finally {
        clearTimeout(id);
    }
}
function apply(ctx, config, options) {
    const logger = ctx.logger('cfmr-notify');
    ctx.model.extend('cfmrmod_notify_sub', {
        id: 'unsigned',
        channelId: 'string',
        platform: 'string',
        projectId: 'string',
        lastVersion: 'string',
        lastNotifiedAt: 'timestamp',
    }, { primary: 'id', autoInc: true });
    const getRoleLevel = (session) => {
        var _a, _b, _c, _d, _e;
        const roles = new Set();
        const list = (_a = session === null || session === void 0 ? void 0 : session.member) === null || _a === void 0 ? void 0 : _a.roles;
        if (Array.isArray(list)) {
            list.forEach((r) => {
                if (typeof r === 'string')
                    roles.add(r);
                else if (r && typeof r === 'object') {
                    if (typeof r.id === 'string')
                        roles.add(r.id);
                    if (typeof r.name === 'string')
                        roles.add(r.name);
                }
            });
        }
        const role = (_b = session === null || session === void 0 ? void 0 : session.member) === null || _b === void 0 ? void 0 : _b.role;
        if (typeof role === 'string')
            roles.add(role);
        const onebotRole = (_d = (_c = session === null || session === void 0 ? void 0 : session.event) === null || _c === void 0 ? void 0 : _c.sender) === null || _d === void 0 ? void 0 : _d.role;
        if (typeof onebotRole === 'string')
            roles.add(onebotRole);
        const eventMember = (_e = session === null || session === void 0 ? void 0 : session.event) === null || _e === void 0 ? void 0 : _e.member;
        if ((eventMember === null || eventMember === void 0 ? void 0 : eventMember.role) && typeof eventMember.role === 'string')
            roles.add(eventMember.role);
        if (Array.isArray(eventMember === null || eventMember === void 0 ? void 0 : eventMember.roles)) {
            eventMember.roles.forEach((r) => {
                if (typeof r === 'string')
                    roles.add(r);
                else if (r && typeof r === 'object') {
                    if (typeof r.id === 'string')
                        roles.add(r.id);
                    if (typeof r.name === 'string')
                        roles.add(r.name);
                }
            });
        }
        if (roles.has('owner'))
            return 3;
        if (roles.has('admin'))
            return 2;
        if (roles.has('member'))
            return 1;
        return 0;
    };
    const isOwner = (session) => getRoleLevel(session) >= 3;
    const isAdmin = (session) => getRoleLevel(session) >= 2;
    const getRoleLevelAsync = async (session) => {
        let level = getRoleLevel(session);
        if (level > 0)
            return level;
        const bot = session === null || session === void 0 ? void 0 : session.bot;
        if ((bot === null || bot === void 0 ? void 0 : bot.getGuildMember) && (session === null || session === void 0 ? void 0 : session.guildId) && (session === null || session === void 0 ? void 0 : session.userId)) {
            try {
                const member = await bot.getGuildMember(session.guildId, session.userId);
                const roles = new Set();
                if ((member === null || member === void 0 ? void 0 : member.role) && typeof member.role === 'string')
                    roles.add(member.role);
                if (Array.isArray(member === null || member === void 0 ? void 0 : member.roles)) {
                    member.roles.forEach((r) => {
                        if (typeof r === 'string')
                            roles.add(r);
                        else if (r && typeof r === 'object') {
                            if (typeof r.id === 'string')
                                roles.add(r.id);
                            if (typeof r.name === 'string')
                                roles.add(r.name);
                        }
                    });
                }
                if (roles.has('owner'))
                    level = 3;
                else if (roles.has('admin'))
                    level = 2;
                else if (roles.has('member'))
                    level = 1;
            }
            catch { }
        }
        return level;
    };
    const requireManage = async (session, channelId) => {
        var _a, _b, _c, _d, _e;
        const level = Number((_a = config.adminAuthority) !== null && _a !== void 0 ? _a : 3);
        if (level <= 1)
            return true;
        if (channelId && channelId !== session.channelId)
            return false;
        const roleLevel = await getRoleLevelAsync(session);
        if (level <= 2)
            return roleLevel >= 2;
        const ok = roleLevel >= 3;
        if (!ok) {
            logger.info(`权限不足调试：level=${level}, role=${(_b = session === null || session === void 0 ? void 0 : session.member) === null || _b === void 0 ? void 0 : _b.role}, roles=${JSON.stringify((_c = session === null || session === void 0 ? void 0 : session.member) === null || _c === void 0 ? void 0 : _c.roles)}, onebotRole=${(_e = (_d = session === null || session === void 0 ? void 0 : session.event) === null || _d === void 0 ? void 0 : _d.sender) === null || _e === void 0 ? void 0 : _e.role}`);
        }
        return ok;
    };
    const parseChannelId = (channelId) => {
        const idx = channelId.indexOf(':');
        if (idx <= 0)
            return null;
        return { platform: channelId.slice(0, idx), id: channelId.slice(idx + 1) };
    };
    const sendToChannel = async (channelId, content) => {
        const parsed = parseChannelId(channelId);
        if (parsed) {
            const bot = ctx.bots.find(b => b.platform === parsed.platform);
            if (bot) {
                await bot.sendMessage(parsed.id, content);
                return true;
            }
        }
        if (ctx.bots.length === 1) {
            await ctx.bots[0].sendMessage(channelId, content);
            return true;
        }
        if (ctx.bots.length) {
            for (const bot of ctx.bots) {
                try {
                    await bot.sendMessage(channelId, content);
                    return true;
                }
                catch { }
            }
        }
        logger.warn(`无法发送到频道 ${channelId}，请使用 platform:channelId 格式。`);
        return false;
    };
    const lastCheckMap = new Map();
    const stateCache = new Map();
    let stateLoaded = false;
    let saving = false;
    let dbWarned = false;
    let configLoaded = false;
    const getStateKey = (channelId, platform, projectId) => {
        return `${channelId}|${platform}|${projectId}`;
    };
    const resolveStateFile = () => {
        const p = String(config.stateFile || 'data/cfmrmod_notify_state.json');
        return path_1.default.isAbsolute(p) ? p : path_1.default.resolve(process.cwd(), p);
    };
    const resolveConfigFile = () => {
        const p = String(config.configFile || 'data/cfmrmod_notify_config.json');
        return path_1.default.isAbsolute(p) ? p : path_1.default.resolve(process.cwd(), p);
    };
    const loadConfigFromFile = async () => {
        if (configLoaded)
            return;
        configLoaded = true;
        try {
            const filePath = resolveConfigFile();
            const content = await fs_1.promises.readFile(filePath, 'utf8');
            const json = JSON.parse(content);
            if (json && typeof json === 'object') {
                if (typeof json.enabled === 'boolean')
                    config.enabled = json.enabled;
                if (Array.isArray(json.groups))
                    config.groups = json.groups;
            }
            if (!Array.isArray(config.groups))
                config.groups = [];
        }
        catch {
            if (!Array.isArray(config.groups))
                config.groups = [];
            if (config.groups.length)
                await saveConfigToFile();
        }
    };
    const saveConfigToFile = async () => {
        try {
            const filePath = resolveConfigFile();
            await fs_1.promises.mkdir(path_1.default.dirname(filePath), { recursive: true });
            const obj = {
                enabled: !!config.enabled,
                groups: Array.isArray(config.groups) ? config.groups : [],
            };
            await fs_1.promises.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf8');
        }
        catch (e) {
            logger.warn(`配置文件写入失败：${e.message}`);
        }
    };
    const loadStateFromFile = async () => {
        if (stateLoaded)
            return;
        stateLoaded = true;
        try {
            const filePath = resolveStateFile();
            const content = await fs_1.promises.readFile(filePath, 'utf8');
            const json = JSON.parse(content);
            if (json && typeof json === 'object') {
                Object.keys(json).forEach(key => {
                    const val = json[key];
                    if (val && typeof val === 'object')
                        stateCache.set(key, { lastVersion: val.lastVersion });
                });
            }
        }
        catch { }
    };
    const saveStateToFile = async () => {
        if (saving)
            return;
        saving = true;
        try {
            const filePath = resolveStateFile();
            await fs_1.promises.mkdir(path_1.default.dirname(filePath), { recursive: true });
            const obj = {};
            for (const [key, val] of stateCache.entries())
                obj[key] = { lastVersion: val.lastVersion };
            await fs_1.promises.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf8');
        }
        catch (e) {
            logger.warn(`状态文件写入失败：${e.message}`);
        }
        finally {
            saving = false;
        }
    };
    const getState = async (channelId, platform, projectId) => {
        await loadStateFromFile();
        const key = getStateKey(channelId, platform, projectId);
        return stateCache.get(key) || null;
    };
    const createState = async (channelId, platform, projectId, lastVersion) => {
        await loadStateFromFile();
        const key = getStateKey(channelId, platform, projectId);
        stateCache.set(key, { lastVersion });
        await saveStateToFile();
    };
    const updateState = async (channelId, platform, projectId, lastVersion) => {
        await loadStateFromFile();
        const key = getStateKey(channelId, platform, projectId);
        stateCache.set(key, { lastVersion });
        await saveStateToFile();
    };
    const getConfigGroups = () => {
        if (!Array.isArray(config.groups))
            config.groups = [];
        return config.groups;
    };
    const getGroup = (channelId) => {
        return getConfigGroups().find((g) => String(g === null || g === void 0 ? void 0 : g.channelId) === String(channelId));
    };
    const ensureGroup = (channelId) => {
        const groups = getConfigGroups();
        let group = groups.find((g) => String(g === null || g === void 0 ? void 0 : g.channelId) === String(channelId));
        if (!group) {
            group = { channelId: String(channelId), enabled: true, subs: [] };
            groups.push(group);
        }
        if (typeof group.enabled !== 'boolean')
            group.enabled = true;
        if (!Array.isArray(group.subs))
            group.subs = [];
        return group;
    };
    const parseOnOff = (value) => {
        if (typeof value !== 'string')
            return null;
        const v = value.trim().toLowerCase();
        if (['1', 'on', 'true', 'yes', 'y'].includes(v))
            return true;
        if (['0', 'off', 'false', 'no', 'n'].includes(v))
            return false;
        return null;
    };
    const getConfigSubs = (channelId) => {
        const groups = getConfigGroups();
        const subs = [];
        for (const group of groups) {
            if (!(group === null || group === void 0 ? void 0 : group.channelId))
                continue;
            if (channelId && group.channelId !== channelId)
                continue;
            if (group.enabled === false)
                continue;
            const list = Array.isArray(group.subs) ? group.subs : [];
            for (const sub of list) {
                const platformKey = normalizePlatform(sub === null || sub === void 0 ? void 0 : sub.platform);
                const projectId = String((sub === null || sub === void 0 ? void 0 : sub.projectId) || '').trim();
                if (!platformKey || !projectId)
                    continue;
                const rawInterval = Number(sub === null || sub === void 0 ? void 0 : sub.interval);
                if (Number.isFinite(rawInterval) && rawInterval <= 0)
                    continue;
                const interval = Math.max(60 * 1000, rawInterval || Number(config.interval) || 30 * 60 * 1000);
                subs.push({ channelId: String(group.channelId), platform: platformKey, projectId, interval });
            }
        }
        return subs;
    };
    const getConfigSubsOrdered = (channelId) => {
        const groups = getConfigGroups();
        const subs = [];
        for (const group of groups) {
            if (!(group === null || group === void 0 ? void 0 : group.channelId))
                continue;
            if (channelId && group.channelId !== channelId)
                continue;
            if (group.enabled === false)
                continue;
            const list = Array.isArray(group.subs) ? group.subs : [];
            for (const sub of list) {
                const platformKey = normalizePlatform(sub === null || sub === void 0 ? void 0 : sub.platform);
                const projectId = String((sub === null || sub === void 0 ? void 0 : sub.projectId) || '').trim();
                if (!platformKey || !projectId)
                    continue;
                const rawInterval = Number(sub === null || sub === void 0 ? void 0 : sub.interval);
                if (Number.isFinite(rawInterval) && rawInterval <= 0)
                    continue;
                const interval = Math.max(60 * 1000, rawInterval || Number(config.interval) || 30 * 60 * 1000);
                subs.push({ channelId: String(group.channelId), platform: platformKey, projectId, interval });
            }
        }
        return subs;
    };
    async function getLatestModrinth(projectId, timeout) {
        const versions = await fetchJson(`${MR_BASE}/project/${projectId}/version`, timeout);
        const latest = Array.isArray(versions) ? versions[0] : null;
        if (!latest)
            return null;
        const file = Array.isArray(latest.files) && latest.files.length ? latest.files[0] : null;
        return {
            versionId: latest.id,
            version: latest.version_number || latest.name || latest.id,
            changelog: latest.changelog || '',
            downloads: latest.downloads,
            datePublished: latest.date_published,
            versionType: latest.version_type,
            loaders: Array.isArray(latest.loaders) ? latest.loaders.map(String) : [],
            gameVersions: Array.isArray(latest.game_versions) ? latest.game_versions.map(String) : [],
            fileName: (file === null || file === void 0 ? void 0 : file.filename) || '',
            fileSize: (file === null || file === void 0 ? void 0 : file.size) || 0,
        };
    }
    async function getLatestCurseForge(projectId, timeout) {
        var _a;
        const files = await fetchJson(`${CF_MIRROR_BASE}/mods/${projectId}/files?index=0&pageSize=1`, timeout);
        const latest = (_a = files === null || files === void 0 ? void 0 : files.data) === null || _a === void 0 ? void 0 : _a[0];
        if (!latest)
            return null;
        return {
            versionId: String(latest.id),
            version: latest.displayName || latest.fileName || String(latest.id),
            changelog: latest.changelog || '',
            downloads: latest.downloadCount,
            datePublished: latest.fileDate || null,
            releaseType: latest.releaseType,
            loaders: Array.isArray(latest.gameVersions) ? latest.gameVersions.filter((v) => /forge|fabric|quilt|neoforge/i.test(String(v))) : [],
            gameVersions: Array.isArray(latest.gameVersions) ? latest.gameVersions.filter((v) => /\d/.test(String(v))) : [],
            fileName: latest.fileName || '',
            fileSize: latest.fileLength || 0,
        };
    }
    async function sendUpdate(channelId, platform, projectId, latest) {
        var _a, _b, _c;
        try {
            let detailData;
            if (platform === 'mr')
                detailData = await (0, cfmr_1.fetchModrinthDetail)(projectId, ((_a = options === null || options === void 0 ? void 0 : options.cfmr) === null || _a === void 0 ? void 0 : _a.requestTimeout) || 15000);
            else
                detailData = await (0, cfmr_1.fetchCurseForgeDetail)(projectId, (_b = options === null || options === void 0 ? void 0 : options.cfmr) === null || _b === void 0 ? void 0 : _b.curseforgeApiKey, ((_c = options === null || options === void 0 ? void 0 : options.cfmr) === null || _c === void 0 ? void 0 : _c.requestTimeout) || 15000, null);
            detailData.type = 'mod';
            const imgBufs = detailData.source === 'CurseForge'
                ? await (0, cfmr_1.drawProjectCardCFNotify)({ ...detailData }, latest)
                : await (0, cfmr_1.drawProjectCardMRNotify)({ ...detailData }, latest);
            for (const buf of imgBufs) {
                const src = await toImageSrc(buf);
                await sendToChannel(channelId, koishi_1.h.image(src));
            }
            // 仅发送卡片，不发送文字
        }
        catch (e) {
            logger.warn(`发送通知失败(${platform}:${projectId}): ${e.message}`);
        }
    }
    async function checkOnce(channelId, force = false) {
        var _a;
        await loadConfigFromFile();
        if (!config.enabled)
            return;
        const subs = getConfigSubs(channelId);
        const stats = { checked: 0, updated: 0, noChange: 0, skipped: 0, failed: 0 };
        for (const sub of subs) {
            try {
                const key = `${sub.channelId}|${sub.platform}|${sub.projectId}`;
                const lastCheck = lastCheckMap.get(key) || 0;
                if (!force && Date.now() - lastCheck < sub.interval) {
                    stats.skipped += 1;
                    continue;
                }
                lastCheckMap.set(key, Date.now());
                stats.checked += 1;
                const timeout = ((_a = options === null || options === void 0 ? void 0 : options.cfmr) === null || _a === void 0 ? void 0 : _a.requestTimeout) || 15000;
                const latest = sub.platform === 'mr'
                    ? await getLatestModrinth(sub.projectId, timeout)
                    : await getLatestCurseForge(sub.projectId, timeout);
                if (!latest) {
                    stats.failed += 1;
                    continue;
                }
                const state = await getState(sub.channelId, sub.platform, sub.projectId);
                if (!state) {
                    await createState(sub.channelId, sub.platform, sub.projectId, latest.version || '');
                    stats.noChange += 1;
                    continue;
                }
                if (!state.lastVersion) {
                    await updateState(sub.channelId, sub.platform, sub.projectId, latest.version);
                    stats.noChange += 1;
                    continue;
                }
                if (latest.version === state.lastVersion) {
                    stats.noChange += 1;
                    continue;
                }
                await sendUpdate(sub.channelId, sub.platform, sub.projectId, latest);
                await updateState(sub.channelId, sub.platform, sub.projectId, latest.version);
                stats.updated += 1;
            }
            catch (e) {
                logger.warn(`检查失败(${sub.platform}:${sub.projectId}): ${e.message}`);
                stats.failed += 1;
            }
        }
        return stats;
    }
    const checkOne = async (sub, forceSendAll) => {
        var _a;
        await loadConfigFromFile();
        const timeout = ((_a = options === null || options === void 0 ? void 0 : options.cfmr) === null || _a === void 0 ? void 0 : _a.requestTimeout) || 15000;
        const latest = sub.platform === 'mr'
            ? await getLatestModrinth(sub.projectId, timeout)
            : await getLatestCurseForge(sub.projectId, timeout);
        if (!latest)
            return { sent: false, updated: false };
        const state = await getState(sub.channelId, sub.platform, sub.projectId);
        if (!state) {
            await createState(sub.channelId, sub.platform, sub.projectId, latest.version || '');
            if (forceSendAll) {
                await sendUpdate(sub.channelId, sub.platform, sub.projectId, latest);
                await updateState(sub.channelId, sub.platform, sub.projectId, latest.version || '');
                return { sent: true, updated: true };
            }
            return { sent: false, updated: false };
        }
        if (forceSendAll) {
            await sendUpdate(sub.channelId, sub.platform, sub.projectId, latest);
            await updateState(sub.channelId, sub.platform, sub.projectId, latest.version || '');
            return { sent: true, updated: true };
        }
        if (!state.lastVersion) {
            await updateState(sub.channelId, sub.platform, sub.projectId, latest.version || '');
            return { sent: false, updated: false };
        }
        if (latest.version === state.lastVersion)
            return { sent: false, updated: false };
        await sendUpdate(sub.channelId, sub.platform, sub.projectId, latest);
        await updateState(sub.channelId, sub.platform, sub.projectId, latest.version || '');
        return { sent: true, updated: true };
    };
    // 自动检查更新定时器
    const startAutoCheck = async () => {
        // 首先加载配置文件
        await loadConfigFromFile();
        // 计算轮询间隔：取所有订阅中最小的 interval，最小不低于 1 分钟
        const getMinInterval = () => {
            const subs = getConfigSubs();
            if (!subs.length)
                return Number(config.interval) || 30 * 60 * 1000;
            const intervals = subs.map(s => s.interval);
            return Math.min(...intervals);
        };
        // 使用较短的基准轮询间隔（1分钟），让 checkOnce 内部判断每个订阅是否到期
        // 这样可以支持每个订阅的独立 interval
        const baseTick = 60 * 1000; // 1 分钟基准轮询
        // 自动轮询函数：每次都检查 config.enabled
        const autoCheckLoop = async () => {
            try {
                await loadConfigFromFile();
                if (config.enabled) {
                    const subs = getConfigSubs();
                    if (subs.length > 0) {
                        logger.debug(`自动检查更新开始，共 ${subs.length} 个订阅...`);
                        const stats = await checkOnce();
                        if (stats) {
                            logger.debug(`自动检查完成: checked=${stats.checked}, updated=${stats.updated}, skipped=${stats.skipped}, failed=${stats.failed}`);
                        }
                    }
                }
            }
            catch (e) {
                logger.warn(`自动检查更新失败: ${e.message}`);
            }
        };
        // 启动时延迟执行一次初始检查（给 bot 连接时间）
        ctx.setTimeout(async () => {
            await autoCheckLoop();
        }, 10 * 1000);
        // 设置定时器，每分钟轮询一次，由 checkOnce 内部判断哪些订阅到期
        ctx.setInterval(autoCheckLoop, baseTick);
        const minInterval = getMinInterval();
        logger.info(`自动更新检查已启动，基准轮询间隔: 1 分钟，最短订阅间隔: ${Math.round(minInterval / 60000)} 分钟`);
    };
    // 使用 ctx.on('ready') 确保在 Koishi 完全就绪后启动
    ctx.on('ready', () => {
        startAutoCheck().catch(e => logger.warn(`启动自动检查失败: ${e.message}`));
    });
    ctx.command('notify.add <platform> <projectId>', '添加更新订阅')
        .action(async ({ session }, platform, projectId) => {
        await loadConfigFromFile();
        if (!platform || !projectId)
            return '参数不足。';
        const platformKey = normalizePlatform(platform);
        if (!platformKey)
            return '平台参数错误，请使用 mr 或 cf。';
        const targetChannel = session.channelId;
        if (!targetChannel)
            return '只能在群聊使用或指定 channelId。';
        if (!await requireManage(session))
            return '权限不足。';
        const pid = String(projectId).trim();
        if (!pid)
            return '项目 ID 不能为空。';
        const group = ensureGroup(targetChannel);
        const list = Array.isArray(group.subs) ? group.subs : [];
        const exists = list.some((s) => normalizePlatform(s === null || s === void 0 ? void 0 : s.platform) === platformKey && String((s === null || s === void 0 ? void 0 : s.projectId) || '').trim() === pid);
        if (exists)
            return `已存在订阅：${platformKey}:${pid}`;
        const interval = Math.max(60 * 1000, Number(config.interval) || 30 * 60 * 1000);
        list.push({ platform: platformKey, projectId: pid, interval });
        group.subs = list;
        await saveConfigToFile();
        return `已添加订阅：${platformKey}:${pid}`;
    });
    ctx.command('notify.remove <platform> <projectId>', '删除更新订阅')
        .action(async ({ session }, platform, projectId) => {
        await loadConfigFromFile();
        if (!platform || !projectId)
            return '参数不足。';
        const platformKey = normalizePlatform(platform);
        if (!platformKey)
            return '平台参数错误，请使用 mr 或 cf。';
        const targetChannel = session.channelId;
        if (!targetChannel)
            return '只能在群聊使用或指定 channelId。';
        if (!await requireManage(session))
            return '权限不足。';
        const pid = String(projectId).trim();
        if (!pid)
            return '项目 ID 不能为空。';
        const group = getGroup(targetChannel);
        if (!group || !Array.isArray(group.subs) || !group.subs.length)
            return '未找到订阅。';
        const before = group.subs.length;
        group.subs = group.subs.filter((s) => !(normalizePlatform(s === null || s === void 0 ? void 0 : s.platform) === platformKey && String((s === null || s === void 0 ? void 0 : s.projectId) || '').trim() === pid));
        if (group.subs.length === before)
            return '未找到订阅。';
        await saveConfigToFile();
        return `已删除订阅：${platformKey}:${pid}`;
    });
    ctx.command('notify.list', '列出订阅')
        .action(async ({ session }) => {
        await loadConfigFromFile();
        const targetChannel = session.channelId;
        if (!targetChannel)
            return '只能在群聊使用或指定 channelId。';
        if (!await requireManage(session))
            return '权限不足。';
        const group = getGroup(targetChannel);
        if (!group)
            return '暂无订阅。';
        const list = Array.isArray(group.subs) ? group.subs : [];
        if (!list.length)
            return group.enabled === false ? '本群通知已禁用，暂无订阅。' : '暂无订阅。';
        const status = group.enabled === false ? '禁用' : '启用';
        const lines = list.map((s, i) => {
            const platformKey = normalizePlatform(s === null || s === void 0 ? void 0 : s.platform) || String((s === null || s === void 0 ? void 0 : s.platform) || '').trim();
            const pid = String((s === null || s === void 0 ? void 0 : s.projectId) || '').trim();
            const rawInterval = Number(s === null || s === void 0 ? void 0 : s.interval);
            const interval = Math.max(60 * 1000, rawInterval || Number(config.interval) || 30 * 60 * 1000);
            return `${i + 1}. ${platformKey}:${pid} (${Math.round(interval / 60000)} 分钟)`;
        });
        return [`本群通知：${status}`, ...lines].join('\n');
    });
    ctx.command('notify.enable <onoff>', '启用/禁用本群通知')
        .action(async ({ session }, onoff) => {
        await loadConfigFromFile();
        const targetChannel = session.channelId;
        if (!targetChannel)
            return '只能在群聊使用或指定 channelId。';
        if (!await requireManage(session))
            return '权限不足。';
        const flag = parseOnOff(onoff);
        if (flag === null)
            return 'onoff 参数错误，请使用 on/off 或 true/false。';
        const group = ensureGroup(targetChannel);
        group.enabled = flag;
        await saveConfigToFile();
        return flag ? '已启用本群通知。' : '已禁用本群通知。';
    });
    ctx.command('notify.helpme', '查看通知系统帮助')
        .action(() => {
        return [
            'notify 使用说明：',
            '1) notify.add ［platform］ ［projectId］  添加订阅',
            '2) notify.remove ［platform］ ［projectId］ 删除订阅',
            '3) notify.list  列出订阅',
            '4) notify.enable ［onoff］ 启用/禁用',
            '5) notify.check [arg] [-b] 手动检查更新（arg 为序号或 projectId）',
            '平台：mr=Modrinth，cf=CurseForge',
            '参数说明：',
            '- ［platform］：平台代码，填写 mr 或 cf',
            '- ［projectId］：平台项目ID（Modrinth/CurseForge 的项目ID，不是名称）',
            '- ［onoff］：启用开关，填写 on/off 或 true/false',
            '- [arg]：notify.check 的参数，可填订阅序号或 projectId',
            '- -b：强制发送最新卡片（忽略是否更新）',
        ].join('\n');
    });
    ctx.command('notify.check [arg]', '手动检查更新')
        .option('broadcast', '-b 直接发送最新版卡片（忽略是否更新）')
        .action(async ({ session, options }, arg) => {
        await loadConfigFromFile();
        const targetChannel = session.channelId;
        if (!targetChannel)
            return '只能在群聊使用或指定 channelId。';
        if (!await requireManage(session))
            return '权限不足。';
        const list = getConfigSubsOrdered(targetChannel);
        if (!list.length)
            return '暂无订阅。';
        let targets = list;
        if (arg) {
            const idx = Number(arg);
            if (Number.isFinite(idx) && idx > 0) {
                const sub = list[idx - 1];
                if (!sub)
                    return '未找到对应序号的订阅。';
                targets = [sub];
            }
            else {
                const sub = list.find(s => s.projectId === String(arg));
                if (!sub)
                    return '未找到对应项目 ID 的订阅。';
                targets = [sub];
            }
        }
        let sent = 0;
        for (const sub of targets) {
            try {
                const res = await checkOne(sub, !!(options === null || options === void 0 ? void 0 : options.broadcast));
                if (res.sent)
                    sent += 1;
            }
            catch (e) {
                logger.warn(`检查失败(${sub.platform}:${sub.projectId}): ${e.message}`);
            }
        }
        if (!sent)
            return '暂无更新。';
    });
}
