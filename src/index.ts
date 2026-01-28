import { Schema } from 'koishi';
import * as cfmr from './plugins/cfmr';
import * as mcmod from './plugins/mcmod';

export const name = 'minecraft-search';

export const Config = Schema.object({
  prefixes: Schema.object({
    cf: Schema.string().default('cf'),
    mr: Schema.string().default('mr'),
    cnmc: Schema.string().default('cnmc'),
  }).description('指令前缀设置'),
  fontPath: Schema.string().role('path').description('中文字体路径 (建议使用含中文和Emoji的字体)'),
  timeouts: Schema.number().default(60000).description('搜索会话超时时间(ms)'),
  debug: Schema.boolean().default(false).description('开启调试日志'),
  cfmr: cfmr.Config.description('CurseForge/Modrinth 搜索与图片卡片'),
  mcmod: mcmod.Config.description('MCMod.cn 搜索与图片卡片'),
});

export function apply(ctx: any, config: any) {
  const prefixes = config?.prefixes || {};
  const shared = {
    prefixes,
    fontPath: config?.fontPath,
    timeouts: config?.timeouts,
    debug: config?.debug,
  };
  if (cfmr.apply) cfmr.apply(ctx, { ...(config?.cfmr || {}), ...shared });
  if (mcmod.apply) mcmod.apply(ctx, { ...(config?.mcmod || {}), ...shared });
}
