"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Config = exports.name = void 0;
exports.apply = apply;
const koishi_1 = require("koishi");
const cfmr = __importStar(require("./plugins/cfmr"));
const mcmod = __importStar(require("./plugins/mcmod"));
exports.name = 'minecraft-search';
exports.Config = koishi_1.Schema.object({
    prefixes: koishi_1.Schema.object({
        cf: koishi_1.Schema.string().default('cf'),
        mr: koishi_1.Schema.string().default('mr'),
        cnmc: koishi_1.Schema.string().default('cnmc'),
    }).description('指令前缀设置'),
    fontPath: koishi_1.Schema.string().role('path').description('中文字体路径 (建议使用含中文和Emoji的字体)'),
    timeouts: koishi_1.Schema.number().default(60000).description('搜索会话超时时间(ms)'),
    debug: koishi_1.Schema.boolean().default(false).description('开启调试日志'),
    cfmr: cfmr.Config.description('CurseForge/Modrinth 搜索与图片卡片'),
    mcmod: mcmod.Config.description('MCMod.cn 搜索与图片卡片'),
});
function apply(ctx, config) {
    const prefixes = (config === null || config === void 0 ? void 0 : config.prefixes) || {};
    const shared = {
        prefixes,
        fontPath: config === null || config === void 0 ? void 0 : config.fontPath,
        timeouts: config === null || config === void 0 ? void 0 : config.timeouts,
        debug: config === null || config === void 0 ? void 0 : config.debug,
    };
    if (cfmr.apply)
        cfmr.apply(ctx, { ...((config === null || config === void 0 ? void 0 : config.cfmr) || {}), ...shared });
    if (mcmod.apply)
        mcmod.apply(ctx, { ...((config === null || config === void 0 ? void 0 : config.mcmod) || {}), ...shared });
}
