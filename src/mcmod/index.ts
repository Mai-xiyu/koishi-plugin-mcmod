const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, registerFont, GlobalFonts } = require('@napi-rs/canvas');
const { h, Schema } = require('koishi');

// Cookie 管理器
let cookieManager = null;
try {
    cookieManager = require('../../cookie-manager');
} catch (e) {
    // cookie-manager 不存在时静默忽略
}

// ================= 状态管理和常量 =================
const searchStates = new Map();
const PAGE_SIZE = 10;
const TIMEOUT_MS = 60000; 
const BASE_URL = 'https://mcmod.cn';
const CENTER_URL = 'https://center.mcmod.cn';

// 备用接口类型映射
const COMMON_SELECT_URL = 'https://www.mcmod.cn/object/CommonSelect/';
const FALLBACK_TYPE_MAP = {
  mod: 'post_relation_mod',
  pack: 'post_relation_modpack',
  author: 'author'
};

// 全局字体变量
let GLOBAL_FONT_FAMILY = 'sans-serif';

// 全局 Cookie 变量
let globalCookie = '';
let cookieLastCheck = 0;
const COOKIE_CHECK_INTERVAL = 30 * 60 * 1000; // 30分钟检查一次

// ================= 辅助工具 =================
async function fetchWithTimeout(url, opts = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

function getHeaders(referer = 'https://mcmod.cn/') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': referer,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (globalCookie) {
    headers['Cookie'] = globalCookie;
  }
  return headers;
}

// 确保 Cookie 有效（自动刷新）
async function ensureValidCookie() {
  const now = Date.now();
  // 如果距离上次检查不到30分钟，跳过
  if (globalCookie && (now - cookieLastCheck) < COOKIE_CHECK_INTERVAL) {
    return;
  }
  
  // 如果有 cookieManager，尝试自动获取
  if (cookieManager) {
    try {
      const cookie = await cookieManager.getCookie();
      if (cookie) {
        globalCookie = cookie;
        cookieLastCheck = now;
      }
    } catch (e) {
      // 静默失败
    }
  }
}

function cleanText(text) {
  if (!text) return '';
  return text.replace(/[\r\n\t]+/g, '').trim();
}

function fixUrl(url) {
    if (!url) return null;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) return BASE_URL + url;
    if (!url.startsWith('http')) return BASE_URL + '/' + url;
    return url;
}

function roundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 1000, draw = true) {
  if (!text) return y;
  const words = text.split('');
  let line = '';
  let linesCount = 0;
  let currentY = y;

  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n];
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      if (draw) ctx.fillText(line, x, currentY);
      line = words[n];
      currentY += lineHeight;
      linesCount++;
      if (linesCount >= maxLines) return currentY;
    } else {
      line = testLine;
    }
  }
  if (draw) ctx.fillText(line, x, currentY);
  return currentY + lineHeight;
}

// ================= 字体注册 =================
function initFont(preferredPath, logger) {
  const fontName = 'MCModFont';
  const tryRegister = (filePath, source) => {
    if (!fs.existsSync(filePath)) return false;
    try {
      if (GlobalFonts.registerFromPath(filePath, fontName)) {
        GLOBAL_FONT_FAMILY = fontName;
        logger.info(`[Font] 成功加载${source}: ${filePath}`);
        return true;
      }
    } catch (e) {}
    return false;
  };

  if (preferredPath) {
    let abs = path.isAbsolute(preferredPath) ? preferredPath : path.resolve(process.cwd(), preferredPath);
    if (tryRegister(abs, '配置字体')) return true;
  }

  const candidates = [
    'C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\msyh.ttf', 'C:\\Windows\\Fonts\\simhei.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.otf', '/usr/share/fonts/noto/NotoSansSC-Regular.otf',
    '/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc', '/System/Library/Fonts/PingFang.ttc'
  ];
  for (const p of candidates) {
    if (tryRegister(p, '系统字体')) return true;
  }
  return false;
}

// ================= 搜索逻辑 =================
async function fetchSearch(query, typeKey) {
  const filterMap = { mod: 1, pack: 2, data: 3, tutorial: 4, author: 5, user: 6 };
  const filter = filterMap[typeKey] || 1;
  const searchUrl = `https://search.mcmod.cn/s?key=${encodeURIComponent(query)}&filter=${filter}&mold=0`;
  
  let results = [];

  // --- 1. 尝试主站爬虫搜索 ---
  try {
      const res = await fetchWithTimeout(searchUrl, { headers: getHeaders('https://search.mcmod.cn/') });
      const html = await res.text();
      const $ = cheerio.load(html);
      
      $('.result-item, .media, .search-list .item, .user-list .row, .list .row').each((i, el) => {
        const $el = $(el);
        let titleEl = $el.find('.head > a').first();
        if (!titleEl.length) titleEl = $el.find('.media-heading a').first();
        if (!titleEl.length) {
            $el.find('a').each((j, a) => {
                if ($(a).text().trim().length > 0 && !titleEl.length) titleEl = $(a);
            });
        }
        
        let title = cleanText(titleEl.text());
        let link = titleEl.attr('href');
        let modName = cleanText($el.find('.meta span, .source').first().text()) || cleanText($el.find('.media-body .text-muted').first().text());

        if (title && link) {
            link = fixUrl(link);
            if (link && !link.includes('target=') && !/^\d+$/.test(title)) {
                let summary = cleanText($el.find('.body, .media-body').text());
                summary = summary.replace(title, '').replace(modName, '').trim();
                results.push({ title, link, modName: modName || '', summary });
            }
        }
      });
  } catch (e) {
      // 主站搜索失败忽略，继续走备用
  }

  // --- 2. 备用接口兜底逻辑 ---
  if (results.length === 0) {
      try {
          const fallbackResults = await fetchSearchFallback(query, typeKey);
          if (fallbackResults && fallbackResults.length > 0) {
              return fallbackResults;
          }
      } catch (e) {
          // 备用接口失败则彻底无结果
      }
  }

  return results;
}

// [修改后] 适配真实返回结构的备用接口
async function fetchSearchFallback(query, typeKey) {
  const apiType = FALLBACK_TYPE_MAP[typeKey];
  if (!apiType) return [];

  try {
    const requestData = { key: query, type: apiType };
    const params = new URLSearchParams();
    params.append('data', JSON.stringify(requestData));

    const headers = {
        ...getHeaders('https://www.mcmod.cn'),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    };

    const res = await fetchWithTimeout(COMMON_SELECT_URL, {
        method: 'POST',
        headers: headers,
        body: params
    });

    const json = await res.json();
    
    // 真实返回结构: { state: 0, html: "<table>...</table>" }
    if (json.state === 0 && json.html) {
        const $ = cheerio.load(json.html);
        const results = [];

        $('tr[data-id]').each((i, el) => {
            const $el = $(el);
            const id = $el.attr('data-id');
            if (!id) return;

            let title = '';
            let summary = '（来自快速索引）';
            let link = '';

            if (typeKey === 'author') {
                // 作者结构: <td><b>酒石酸菌</b> - <i class="text-muted">TartaricAcid...</i></td>
                title = cleanText($el.find('b').text()) || cleanText($el.text());
                summary = cleanText($el.find('i').text());
                link = `https://www.mcmod.cn/author/${id}.html`;
            } else {
                // 模组/整合包结构: <td>ID:19638 [RWFJ] 彩虹扳手...</td>
                const rawText = cleanText($el.text());
                // 去掉开头的 "ID:12345 "，保留后面更有用的名称
                title = rawText.replace(/^ID:\d+\s*/, ''); 
                link = `https://www.mcmod.cn/class/${id}.html`;
                summary = `ID: ${id}`; // 模组把 ID 放在摘要里
            }

            if (title && link) {
                results.push({
                    title: title,
                    link: link,
                    modName: typeKey === 'pack' ? '整合包' : '',
                    summary: summary
                });
            }
        });
        return results;
    }
  } catch (e) {
    // console.error('备用接口解析失败:', e);
  }
  return [];
}

function formatListPage(items, pageIndex, type) {
  const total = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = items.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);
  const typeName = { mod: '模组', pack: '整合包', data: '资料', tutorial: '教程', author: '作者', user: '用户' }[type] || '结果';
  let text = `[mcmod] 搜索到的${typeName} (第 ${pageIndex + 1}/${total} 页):\n`;
  page.forEach((it, idx) => text += `${(pageIndex * PAGE_SIZE) + idx + 1}. ${it.title}${it.modName ? ` 《${it.modName.replace(/[《》]/g, '')}》` : ''}\n`);
  text += '\n发送序号选择，p/n 翻页，q 退出。';
  return text;
}


// ================= 渲染：模组/整合包卡片 (macOS 风格) =================
async function drawModCard(url) {
    const res = await fetchWithTimeout(url, { headers: getHeaders() });
    const html = await res.text();
    const $ = cheerio.load(html);

    // --- 1. 数据抓取 (保持原逻辑，确保稳定性) ---
    const titleHtml = $('.class-title').html() || '';
    const cleanTitleStr = titleHtml
        .replace(/<div class="class-official-group"[\s\S]*?<\/div>/gi, '')
        .replace(/<[^>]+>/g, '\n');
    const titleLines = cleanTitleStr.split('\n').map(s=>s.trim()).filter(s=>s);
    const title = titleLines[0] || cleanText($('.class-title').text().replace(/开源|活跃|稳定|闭源|停更|弃坑|半弃坑|Beta/g, '').trim());
    const subTitle = titleLines.slice(1).join(' ');

    let coverUrl = fixUrl($('.class-cover-image img').attr('src'));
    let iconUrl = fixUrl($('.class-icon img').attr('src'));
    // 如果没有封面，用图标代替；如果没有图标，尝试用封面代替
    if (!coverUrl && iconUrl) coverUrl = iconUrl;
    if (!iconUrl && coverUrl) iconUrl = coverUrl;

    // 标签
    const tags = [];
    const officialTags = new Set();
    $('.class-official-group div').each((i, el) => {
      const txt = cleanText($(el).text());
      if (!txt || txt.length > 20) return;
      officialTags.add(txt);
      let color = '#999', bg = '#eee';
      if (txt.includes('开源') || txt.includes('活跃') || txt.includes('稳定')) { color = '#2ecc71'; bg = '#e8f5e9'; }
      else if (txt.includes('半弃坑') || txt.includes('Beta')) { color = '#f39c12'; bg = '#fef9e7'; }
      else if (txt.includes('停更') || txt.includes('闭源') || txt.includes('弃坑')) { color = '#e74c3c'; bg = '#fce4ec'; }
      tags.push({ t: txt, bg, c: color });
    });
    $('.class-label-list a').each((i, el) => {
      const labelText = cleanText($(el).text());
      if (!labelText || officialTags.has(labelText)) return;
      const cls = $(el).attr('class') || '';
      let bg = '#e3f2fd', c = '#3498db';
      if(cls.includes('c_1')) { bg='#e8f5e9'; c='#2ecc71'; } 
      else if(cls.includes('c_3')) { bg='#fff3e0'; c='#e67e22'; }
      tags.push({ t: labelText, bg, c });
    });

    // 统计数据
    let score = cleanText($('.class-score-num').text());
    let scoreComment = '';
    if(!score || score === '') {
      score = cleanText($('.class-excount .star .up').text()) || '0.0';
      scoreComment = cleanText($('.class-excount .star .down').text());
    }
    if (!scoreComment) scoreComment = '暂无评价';
    const yIndex = cleanText($('.class-excount .star .text').first().text().replace('昨日指数:','').trim());
    
    let viewNum = '0', fillRate = '--';
    $('.class-excount .infos .span').each((i, el) => {
      const t = $(el).find('.t').text();
      const n = cleanText($(el).find('.n').text());
      if(t.includes('浏览')) viewNum = n;
      if(t.includes('填充')) fillRate = n;
    });

    function getSocialNum(className) {
      let result = '0';
      const selectors = [
        `.common-fuc-group li.${className} div.nums`, `.common-fuc-group li.${className} .nums`,
        `li.${className} div.nums`, `li.${className} .nums`
      ];
      for (const sel of selectors) {
        const el = $(sel);
        if (el.length > 0) {
          const titleAttr = el.attr('title');
          if (titleAttr && /^\d+$/.test(titleAttr.replace(/,/g, '').trim())) { result = titleAttr.replace(/,/g, '').trim(); break; }
          const text = el.text().replace(/,/g, '').trim();
          if (text && /^\d+$/.test(text)) { result = text; break; }
        }
      }
      return result;
    }
    const pushNum = getSocialNum('push');
    const favNum = getSocialNum('like');
    const subNum = getSocialNum('subscribe');

    // 作者
    const authors = [];
    $('.author-list li, .author li').each((i, el) => {
      const n = cleanText($(el).find('.name').text());
      const r = cleanText($(el).find('.position').text());
      const iurl = fixUrl($(el).find('img').attr('src'));
      if(n) authors.push({ n, r, i: iurl });
    });

    // 属性
    const props = [];
    $('.class-meta-list li').each((i, el) => {
      const l = cleanText($(el).find('h4').text());
      const v = cleanText($(el).find('.text').text());
      if(l && v && !l.includes('编辑') && !l.includes('推荐') && !l.includes('收录') && !l.includes('最后')) {
        props.push({ l, v });
      }
    });

    // 版本
    const versions = [];
    const mcVerRoot = $('.mcver');
    let verGroups = mcVerRoot.find('ul ul'); 
    if (verGroups.length === 0) verGroups = mcVerRoot.find('ul').first();
    const allUls = mcVerRoot.find('ul');
    allUls.each((i, ul) => {
      if ($(ul).find('ul').length > 0) return;
      let loader = '';
      const vers = [];
      $(ul).find('li').each((j, li) => {
        const txt = cleanText($(li).text());
        if (txt.includes(':') || txt.includes('：')) loader = txt.replace(/[:：]/g, '').trim();
        else vers.push(txt);
      });
      if (loader && vers.length > 0) versions.push({ l: loader, v: vers.join(', ') });
    });

    // 链接
    const links = [];
    $('.common-link-icon-frame a').each((i, el) => {
      const name = $(el).attr('data-original-title') || 'Link';
      let sn = name;
      if(name.includes('GitHub')) sn='GitHub';
      else if(name.includes('CurseForge')) sn='CurseForge';
      else if(name.includes('Modrinth')) sn='Modrinth';
      else if(name.includes('百科')) sn='Wiki';
      links.push(sn);
    });

    // 简介解析
    const descRoot = $('.common-text').first();
    const descNodes = [];
    function parseNode(node, depth = 0) {
      if (depth > 10) return;
      if (node.type === 'text') {
        const t = cleanText(node.data);
        if (t && t.length > 1) {
          const lastNode = descNodes[descNodes.length - 1];
          if (!lastNode || lastNode.type !== 't' || lastNode.val !== t) descNodes.push({ type: 't', val: t, tag: 'p' });
        }
      } else if (node.type === 'tag') {
        const tagName = node.name;
        if (tagName === 'img') {
          const src = node.attribs['data-src'] || node.attribs['src'];
          if (src && !src.includes('icon') && !src.includes('smilies') && !src.includes('loading')) descNodes.push({ type: 'i', src: fixUrl(src) });
        } else if (['h1','h2','h3','h4','h5','h6'].includes(tagName)) {
          const text = cleanText($(node).text());
          if (text && text.length > 1) descNodes.push({ type: 't', val: text, tag: 'h' });
        } else if (tagName === 'li') {
          const text = cleanText($(node).text());
          if (text && text.length > 1) descNodes.push({ type: 't', val: '• ' + text, tag: 'li' });
        } else if (tagName === 'br') {
          descNodes.push({ type: 'br' });
        } else if (['p','div','span','section','article','ul','ol','strong','b','em','i'].includes(tagName)) {
          if (node.children) node.children.forEach(child => parseNode(child, depth + 1));
        }
      }
    }
    if (descRoot.length) descRoot[0].children.forEach(child => parseNode(child, 0));
    if (descNodes.length === 0) {
      const metaDesc = $('meta[name="description"]').attr('content');
      if (metaDesc) descNodes.push({ type: 't', val: metaDesc, tag: 'p' });
    }

    // --- 2. 布局计算 (macOS 风格) ---
    const width = 800;
    const font = GLOBAL_FONT_FAMILY;
    const margin = 20; // 窗口外边距
    const winPadding = 35; // 窗口内边距
    const contentW = width - margin * 2 - winPadding * 2;
    
    // 预计算高度
    const dummyC = createCanvas(100, 100);
    const dummy = dummyC.getContext('2d');
    dummy.font = `bold 32px "${font}"`;

    // 头部区域 (Header)
    let headerH = 100; // Icon(80) + padding
    const titleLinesNum = wrapText(dummy, title, 0, 0, contentW - 100, 40, 10, false) / 40;
    headerH = Math.max(headerH, 10 + titleLinesNum * 40 + (subTitle ? 25 : 0) + (authors.length ? 40 : 0));
    
    // 标签区域
    let tagsH = 0;
    if (tags.length) tagsH = 40;

    // 封面图 (Cover)
    let coverH = 0;
    if (coverUrl) coverH = 300; // 固定封面显示高度

    // 统计数据 (Stats Grid)
    // 布局：每行4个数据
    const statsItems = [
      { l: '评分', v: score }, { l: '热度', v: viewNum }, 
      { l: '推荐', v: pushNum }, { l: '收藏', v: favNum },
      { l: '关注', v: subNum }
    ];
    if (fillRate !== '--') statsItems.push({ l: '填充率', v: fillRate });
    if (yIndex) statsItems.push({ l: '昨日指数', v: yIndex });
    
    let statsH = 0;
    if (statsItems.length) {
      const rows = Math.ceil(statsItems.length / 4);
      statsH = rows * 70 + (rows - 1) * 15;
    }

    // 属性列表 (Props)
    let propsH = 0;
    if (props.length) {
      const rows = Math.ceil(props.length / 2);
      propsH = rows * 30 + 10;
    }

    // 版本和链接
    let extraH = 0;
    if (versions.length) {
      extraH += 30; // Title
      versions.forEach(v => {
        dummy.font = `14px "${font}"`;
        const lw = dummy.measureText(v.l).width + 10;
        const lines = wrapText(dummy, v.v, 0, 0, contentW - lw, 20, 100, false) / 20;
        extraH += lines * 20 + 10;
      });
    }
    if (links.length) extraH += 50;

    // 简介 (Desc)
    let descH = 0;
    dummy.font = `16px "${font}"`;
    for (const node of descNodes) {
      if (node.type === 't') {
        const isHeader = node.tag === 'h';
        dummy.font = `${isHeader ? 'bold' : ''} ${isHeader ? 22 : 16}px "${font}"`;
        const lh = isHeader ? 32 : 26;
        const lines = wrapText(dummy, node.val, 0, 0, contentW, lh, 100, false) / lh;
        descH += lines * lh + (isHeader ? 15 : 10);
      } else if (node.type === 'i') {
        descH += 400; // 估算图片高度
      } else if (node.type === 'br') {
        descH += 10;
      }
    }
    if (descH > 0) descH += 50; // Title + Padding

    // 总高度
    let cursorY = margin + 40; // Top traffic lights area
    const components = [
      { h: headerH, gap: 20 },
      { h: tagsH, gap: 10 },
      { h: coverH, gap: 25 },
      { h: statsH, gap: 25 },
      { h: propsH, gap: 25 },
      { h: extraH, gap: 25 },
      { h: descH, gap: 20 }
    ];
    
    components.forEach(c => { if(c.h > 0) cursorY += c.h + c.gap; });
    const windowH = cursorY;
    const totalH = windowH + margin * 2;

    // --- 3. 开始绘制 ---
    const canvas = createCanvas(width, totalH);
    const ctx = canvas.getContext('2d');

    // 背景 (Bing 壁纸)
    try {
      const bgUrl = 'https://bing.biturl.top/?resolution=1920&format=image&index=0&mkt=zh-CN';
      const bgImg = await loadImage(bgUrl);
      const r = Math.max(width / bgImg.width, totalH / bgImg.height);
      ctx.drawImage(bgImg, (width - bgImg.width * r) / 2, (totalH - bgImg.height * r) / 2, bgImg.width * r, bgImg.height * r);
      ctx.fillStyle = 'rgba(0,0,0,0.15)'; // 遮罩
      ctx.fillRect(0, 0, width, totalH);
    } catch (e) {
      const grad = ctx.createLinearGradient(0, 0, 0, totalH);
      grad.addColorStop(0, '#e0c3fc'); grad.addColorStop(1, '#8ec5fc');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, width, totalH);
    }

    // 窗口 (Acrylic)
    const winX = margin;
    const winY = margin;
    
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.2)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 20;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    roundRect(ctx, winX, winY, width - margin * 2, windowH, 16);
    ctx.fill();
    ctx.restore();
    
    // 窗口边框
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
    roundRect(ctx, winX, winY, width - margin * 2, windowH, 16);
    ctx.stroke();

    // 交通灯
    const trafficY = winY + 20;
    ['#ff5f56', '#ffbd2e', '#27c93f'].forEach((c, i) => {
      ctx.beginPath(); ctx.arc(winX + 20 + i * 25, trafficY, 6, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
    });

    // --- 内容绘制 ---
    let dy = winY + 50;
    const cx = winX + winPadding;

    // 1. Header
    // Icon
    const iconSize = 80;
    if (iconUrl) {
      try {
        const img = await loadImage(iconUrl);
        ctx.save();
        roundRect(ctx, cx, dy, iconSize, iconSize, 12); ctx.clip();
        ctx.drawImage(img, cx, dy, iconSize, iconSize);
        ctx.restore();
      } catch(e) {
        ctx.fillStyle = '#ddd'; roundRect(ctx, cx, dy, iconSize, iconSize, 12); ctx.fill();
      }
    }
    
    // Title
    const titleX = cx + iconSize + 20;
    ctx.fillStyle = '#333'; ctx.font = `bold 32px "${font}"`; ctx.textBaseline = 'top';
    const titleDrawnH = wrapText(ctx, title, titleX, dy - 5, contentW - iconSize - 20, 40, 3, true);
    
    // SubTitle
    let subY = titleDrawnH + 5;
    if (subTitle) {
      ctx.fillStyle = '#888'; ctx.font = `16px "${font}"`;
      ctx.fillText(subTitle, titleX, subY);
      subY += 25;
    }

    // Authors
    if (authors.length) {
      let ax = titleX;
      for (const a of authors.slice(0, 3)) { // 最多显示3个作者
        ctx.save(); ctx.beginPath(); ctx.arc(ax + 12, subY + 12, 12, 0, Math.PI * 2); ctx.clip();
        if (a.i) { try { const img = await loadImage(a.i); ctx.drawImage(img, ax, subY, 24, 24); } catch(e) { ctx.fillStyle='#ccc'; ctx.fill(); } }
        else { ctx.fillStyle='#ccc'; ctx.fill(); }
        ctx.restore();
            
        ctx.fillStyle = '#666'; ctx.font = `14px "${font}"`;
        ctx.fillText(a.n, ax + 30, subY + 5);
        ax += ctx.measureText(a.n).width + 45;
      }
    }
    
    dy += Math.max(headerH, 100) + 20;

    // 2. Tags
    if (tags.length) {
      let tx = cx;
      tags.forEach(t => {
        ctx.font = `12px "${font}"`;
        const tw = ctx.measureText(t.t).width + 20;
        if (tx + tw < cx + contentW) {
          ctx.fillStyle = t.bg; roundRect(ctx, tx, dy, tw, 24, 6); ctx.fill();
          ctx.fillStyle = t.c; ctx.fillText(t.t, tx + 10, dy + 6);
          tx += tw + 10;
        }
      });
      dy += 35;
    }

    // 3. Cover Image
    if (coverUrl) {
      try {
        const img = await loadImage(coverUrl);
        const coverW = contentW;
        const coverH_Actual = 280;
        // Crop fit
        const r = Math.max(coverW / img.width, coverH_Actual / img.height);
        ctx.save();
        roundRect(ctx, cx, dy, coverW, coverH_Actual, 12); ctx.clip();
        ctx.drawImage(img, (coverW - img.width * r) / 2 + cx, (coverH_Actual - img.height * r) / 2 + dy, img.width * r, img.height * r);
        ctx.restore();
        dy += coverH_Actual + 25;
      } catch(e) {}
    }

    // 4. Stats Grid
    if (statsItems.length) {
      const cols = 4;
      const gap = 15;
      const itemW = (contentW - (cols - 1) * gap) / cols;
      const itemH = 70;
        
      statsItems.forEach((s, i) => {
        const c = i % cols; const r = Math.floor(i / cols);
        const x = cx + c * (itemW + gap);
        const y = dy + r * (itemH + gap);
            
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        roundRect(ctx, x, y, itemW, itemH, 10); ctx.fill();
            
        ctx.textAlign = 'center';
        ctx.fillStyle = '#888'; ctx.font = `12px "${font}"`;
        ctx.fillText(s.l, x + itemW / 2, y + 15);
        ctx.fillStyle = '#333'; ctx.font = `bold 20px "${font}"`;
        ctx.fillText(s.v, x + itemW / 2, y + 40);
      });
      ctx.textAlign = 'left';
      dy += Math.ceil(statsItems.length / cols) * (itemH + gap) + 10;
    }

    // 5. Props List
    if (props.length) {
      const colW = contentW / 2;
      props.forEach((p, i) => {
        const c = i % 2; const r = Math.floor(i / 2);
        const x = cx + c * colW;
        const y = dy + r * 30;
            
        ctx.fillStyle = '#888'; ctx.font = `14px "${font}"`;
        ctx.fillText(p.l + ':', x, y);
        const lw = ctx.measureText(p.l + ':').width;
        ctx.fillStyle = '#333'; 
        // 截断过长文本
        let val = p.v;
        while(ctx.measureText(val).width > colW - lw - 20 && val.length > 5) val = val.slice(0, -1);
        if(val.length < p.v.length) val += '...';
        ctx.fillText(val, x + lw + 10, y);
      });
      dy += Math.ceil(props.length / 2) * 30 + 15;
    }

    // 6. Versions & Links
    if (versions.length) {
      ctx.fillStyle = '#333'; ctx.font = `bold 16px "${font}"`; ctx.fillText('支持版本', cx, dy); dy += 25;
      versions.forEach(v => {
        ctx.fillStyle = '#555'; ctx.font = `bold 14px "${font}"`; ctx.fillText(v.l, cx, dy);
        const lw = ctx.measureText(v.l).width + 10;
        ctx.fillStyle = '#e74c3c'; ctx.font = `14px "${font}"`; 
        dy = wrapText(ctx, v.v, cx + lw, dy, contentW - lw, 20, 500, true) + 5;
      });
      dy += 15;
    }
    if (links.length) {
      let lx = cx;
      links.forEach(l => {
        ctx.font = `bold 12px "${font}"`;
        const w = ctx.measureText(l).width + 20;
        if (lx + w < cx + contentW) {
          ctx.fillStyle = '#333'; roundRect(ctx, lx, dy, w, 24, 12); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.fillText(l, lx + 10, dy + 6);
          lx += w + 10;
        }
      });
      dy += 45;
    }

    // 7. Description
    if (descNodes.length) {
      ctx.fillStyle = '#333'; ctx.font = `bold 20px "${font}"`; ctx.fillText('简介', cx, dy);
      ctx.fillStyle = '#3498db'; ctx.fillRect(cx, dy + 25, 40, 4);
      dy += 45;
        
      for (const node of descNodes) {
        if (node.type === 't') {
          const isHeader = node.tag === 'h';
          ctx.font = `${isHeader ? 'bold' : ''} ${isHeader ? 22 : 16}px "${font}"`;
          ctx.fillStyle = isHeader ? '#2c3e50' : '#444';
          const lh = isHeader ? 32 : 26;
          dy = wrapText(ctx, node.val, cx, dy, contentW, lh, 5000, true) + (isHeader ? 15 : 10);
        } else if (node.type === 'i') {
          try {
            const img = await loadImage(node.src);
            const maxH = 400;
            const r = Math.min(contentW / img.width, maxH / img.height);
            const dw = img.width * r; const dh = img.height * r;
            ctx.drawImage(img, cx + (contentW - dw) / 2, dy, dw, dh);
            dy += dh + 20;
          } catch(e) {}
        } else if (node.type === 'br') {
          dy += 10;
        }
      }
    }

    // Footer
    ctx.fillStyle = '#999'; ctx.font = `12px "${font}"`; ctx.textAlign = 'center';
    ctx.fillText('mcmod.cn | Powered by Koishi', width / 2, totalH - 12);

    return canvas.toBuffer('image/png');
  }

  // ================= 渲染：教程卡片 (macOS 风格) =================
  async function drawTutorialCard(url) {
    const res = await fetchWithTimeout(url, { headers: getHeaders() });
    const html = await res.text();
    const $ = cheerio.load(html);

    // --- 1. 核心数据抓取 ---

    // 标题
    const title = cleanText($('h1, .post-title, .article-title, .postname h5').first().text()) || cleanText($('title').text().split('-')[0]);
    
    // 作者
    let author = cleanText($('.post-user-frame .post-user-name a').first().text());
    if (!author) author = cleanText($('.post-user-name a').first().text());
    if (!author) author = cleanText($('a[href*="/center/"]').first().text());
    if (!author) author = '未知作者';
    
    // 头像
    let authorAvatar = fixUrl($('.post-user-frame .post-user-avatar img').attr('src'));
    if (!authorAvatar) authorAvatar = fixUrl($('.post-user-avatar img').attr('src'));

    // 浏览量/日期
    let views = '0';
    let date = '';
    $('.common-rowlist-2 li').each((i, el) => {
      const text = $(el).text();
      if (text.includes('浏览量')) views = text.replace(/[^0-9]/g, '') || '0';
      if (text.includes('创建日期')) {
        const fullDate = $(el).attr('data-original-title');
        date = fullDate ? fullDate.split(' ')[0] : text.replace('创建日期：', '').trim();
      }
    });
    
    // 互动数据
    function getSocialNum(className) {
      let result = '0';
      const selectors = [
        `.common-fuc-group[data-category="post"] li.${className} div.nums`,
        `.common-fuc-group li.${className} div.nums`,
        `.common-fuc-group li.${className} .nums`,
        `li.${className} div.nums`,
      ];
      for (const sel of selectors) {
        const el = $(sel);
        if (el.length > 0) {
          const titleAttr = el.attr('title');
          if (titleAttr) {
            const num = titleAttr.replace(/,/g, '').trim();
            if (num && /^\d+$/.test(num)) return num;
          }
          const text = el.text().replace(/,/g, '').trim();
          if (text && /^\d+$/.test(text)) return text;
        }
      }
      return result;
    }
    const pushNum = getSocialNum('push');
    const favNum = getSocialNum('like');

    // 目录
    const tocItems = [];
    $('a[href^="javascript:void(0);"]').each((i, el) => {
      const text = cleanText($(el).text());
      if (text && text.length > 2 && text.length < 50 && !text.includes('百科') && !text.includes('登录')) {
        tocItems.push(text);
      }
    });

    // 正文提取
    const contentNodes = [];
    const contentRoot = $('.post-content, .article-content, .common-text, .news-text').first();
    
    function parseContent(node) {
      if (node.type === 'text') {
        const t = cleanText(node.data);
        if (t && t.length > 1) contentNodes.push({ type: 't', val: t, tag: 'p' });
      } else if (node.type === 'tag') {
        const tagName = node.name;
        if (tagName === 'img') {
          const src = node.attribs['data-src'] || node.attribs['src'];
          if (src && !src.includes('loading') && !src.includes('smilies') && !src.includes('icon')) {
            contentNodes.push({ type: 'i', src: fixUrl(src) });
          }
        } else if (['h1','h2','h3','h4'].includes(tagName)) {
          const text = cleanText($(node).text());
          if (text) contentNodes.push({ type: 't', val: text, tag: 'h' });
        } else if (tagName === 'li') {
          const text = cleanText($(node).text());
          if (text) contentNodes.push({ type: 't', val: '• ' + text, tag: 'li' });
        } else if (['p', 'div', 'blockquote', 'span', 'strong', 'b', 'i', 'em'].includes(tagName)) {
          if (node.children) node.children.forEach(parseContent);
        } else {
          if (node.children) node.children.forEach(parseContent);
        }
      }
    }
    
    if (contentRoot.length) {
      const textContainer = contentRoot.find('.text').first();
      if (textContainer.length > 0) textContainer[0].children.forEach(parseContent);
      else contentRoot[0].children.forEach(parseContent);
    }
    
    if (contentNodes.length === 0) {
      const metaDesc = $('meta[name="description"]').attr('content');
      if (metaDesc) contentNodes.push({ type: 't', val: metaDesc, tag: 'p' });
    }

    // --- 2. 布局常量定义 ---
    const width = 1000;
    const font = GLOBAL_FONT_FAMILY;
    const margin = 20;
    const winPadding = 40;
    const contentW = width - margin * 2 - winPadding * 2;

    // --- 3. 关键步骤：预加载图片以获取真实高度 ---
    // 并行加载所有图片，确保后续高度计算准确
    await Promise.all(contentNodes.map(async (node) => {
      if (node.type === 'i') {
        try {
          const img = await loadImage(node.src);
          node.img = img; // 保存 Image 对象
          // 计算自适应尺寸：宽度最大为 contentW，高度按比例缩放，不设上限
          const scale = Math.min(contentW / img.width, 1); 
          node.dw = img.width * scale;
          node.dh = img.height * scale;
        } catch (e) {
          node.error = true;
        }
      }
    }));

    // --- 4. 精确计算总高度 ---
    const dummyC = createCanvas(100, 100);
    const dummy = dummyC.getContext('2d');
    let totalH = 0;
    
    // Header 高度
    dummy.font = `bold 32px "${font}"`;
    const titleLines = wrapText(dummy, title, 0, 0, contentW, 45, 5, false) / 45;
    const headerH = 60 + titleLines * 45 + 50 + 20;
    totalH += headerH;

    // TOC 高度
    let tocH = 0;
    if (tocItems.length > 0) {
      tocH = 50 + Math.ceil(tocItems.length / 2) * 35 + 20;
      totalH += tocH;
    }

    // 正文高度 (使用真实图片高度)
    let contentH = 0;
    dummy.font = `16px "${font}"`;
    for (const node of contentNodes) {
      if (node.type === 't') {
        const isHeader = node.tag === 'h';
        const fontSize = isHeader ? 22 : 16;
        dummy.font = `${isHeader ? 'bold' : ''} ${fontSize}px "${font}"`;
        const lineHeight = Math.floor(fontSize * 1.6);
        // 这里不再限制行数 (limit = 10000)，显示全部文本
        const lines = wrapText(dummy, node.val, 0, 0, contentW, lineHeight, 10000, false) / lineHeight;
        contentH += lines * lineHeight + (isHeader ? 25 : 15);
      } else if (node.type === 'i' && !node.error && node.img) {
        // 使用预加载时计算出的真实高度
        contentH += node.dh + 25; 
      }
    }
    if (contentH === 0) contentH = 100;
    totalH += contentH + 50; // Padding

    const windowH = totalH+100;
    const canvasH = windowH + margin * 2;

    // --- 5. 绘制 ---
    const canvas = createCanvas(width, canvasH);
    const ctx = canvas.getContext('2d');

    // 背景 (Bing)
    try {
      const bgUrl = 'https://bing.biturl.top/?resolution=1920&format=image&index=0&mkt=zh-CN';
      const bgImg = await loadImage(bgUrl);
      const r = Math.max(width / bgImg.width, canvasH / bgImg.height);
      ctx.drawImage(bgImg, (width - bgImg.width * r) / 2, (canvasH - bgImg.height * r) / 2, bgImg.width * r, bgImg.height * r);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.fillRect(0, 0, width, canvasH);
    } catch (e) {
      const grad = ctx.createLinearGradient(0, 0, 0, canvasH);
      grad.addColorStop(0, '#a18cd1'); grad.addColorStop(1, '#fbc2eb');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, width, canvasH);
    }

    // 窗口主体
    const winX = margin, winY = margin;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.2)'; ctx.shadowBlur = 50; ctx.shadowOffsetY = 20;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    roundRect(ctx, winX, winY, width - margin * 2, windowH, 16);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
    roundRect(ctx, winX, winY, width - margin * 2, windowH, 16); ctx.stroke();

    // 交通灯
    ['#ff5f56', '#ffbd2e', '#27c93f'].forEach((c, i) => {
      ctx.beginPath(); ctx.arc(winX + 25 + i * 25, winY + 25, 6, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
    });

    // --- 内容绘制 ---
    let dy = winY + 60;
    const cx = winX + winPadding;

    // 1. Header
    ctx.fillStyle = '#333'; ctx.font = `bold 32px "${font}"`; ctx.textBaseline = 'top';
    const drawnTitleH = wrapText(ctx, title, cx, dy, contentW, 45, 5, true);
    dy += drawnTitleH + 20;

    // Meta Info
    const avSize = 40;
    if (authorAvatar) {
      try {
        const img = await loadImage(authorAvatar);
        ctx.save(); ctx.beginPath(); ctx.arc(cx + avSize/2, dy + avSize/2, avSize/2, 0, Math.PI*2); ctx.clip();
        ctx.drawImage(img, cx, dy, avSize, avSize); ctx.restore();
      } catch(e) {
        ctx.fillStyle = '#ccc'; ctx.beginPath(); ctx.arc(cx + avSize/2, dy + avSize/2, avSize/2, 0, Math.PI*2); ctx.fill();
      }
    } else {
      ctx.fillStyle = '#ccc'; ctx.beginPath(); ctx.arc(cx + avSize/2, dy + avSize/2, avSize/2, 0, Math.PI*2); ctx.fill();
    }

    ctx.fillStyle = '#333'; ctx.font = `bold 16px "${font}"`;
    ctx.fillText(author, cx + avSize + 15, dy + 5);
    ctx.fillStyle = '#888'; ctx.font = `12px "${font}"`;
    ctx.fillText(date || '未知日期', cx + avSize + 15, dy + 25);

    // Stats
    const statsY = dy + 10;
    let sx = cx + contentW;
    const drawStat = (icon, val, color) => {
      ctx.textAlign = 'right';
      ctx.fillStyle = color; ctx.font = `bold 16px "${font}"`;
      const vw = ctx.measureText(val).width;
      ctx.fillText(val, sx, statsY);
      ctx.fillStyle = '#999'; ctx.font = `12px "${font}"`;
      ctx.fillText(icon, sx - vw - 5, statsY);
      sx -= (vw + 5 + ctx.measureText(icon).width + 20);
      ctx.textAlign = 'left';
    };
    
    drawStat('收藏', favNum, '#f1c40f');
    drawStat('推荐', pushNum, '#e74c3c');
    drawStat('浏览', views, '#3498db');

    dy += avSize + 30;

    // Divider
    ctx.fillStyle = 'rgba(0,0,0,0.05)'; ctx.fillRect(cx, dy, contentW, 1);
    dy += 25;

    // 2. TOC
    if (tocItems.length > 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.03)';
      roundRect(ctx, cx, dy, contentW, tocH - 20, 10); ctx.fill();
      ctx.fillStyle = '#555'; ctx.font = `bold 16px "${font}"`;
      ctx.fillText('目录', cx + 20, dy + 30);
        
      let tx = cx + 20; let ty = dy + 60;
      const colW = (contentW - 40) / 2;
      ctx.fillStyle = '#666'; ctx.font = `14px "${font}"`;
      tocItems.forEach((item, i) => {
        const col = i % 2; 
        if (col === 0 && i > 0) ty += 30;
        const x = tx + col * colW;
        let displayTitle = item;
        if (ctx.measureText(displayTitle).width > colW - 20) {
          while (ctx.measureText(displayTitle + '...').width > colW - 20 && displayTitle.length > 0) displayTitle = displayTitle.slice(0, -1);
          displayTitle += '...';
        }
        ctx.fillText(`${i+1}. ${displayTitle}`, x, ty);
      });
      dy += tocH + 10;
    }

    // 3. Content (Drawing loop)
    for (const node of contentNodes) {
      if (node.type === 't') {
        const isHeader = node.tag === 'h';
        const fontSize = isHeader ? 22 : 16;
        ctx.font = `${isHeader ? 'bold' : ''} ${fontSize}px "${font}"`;
        ctx.fillStyle = isHeader ? '#2c3e50' : '#444';
            
        if (isHeader) {
          ctx.fillStyle = '#3498db';
          ctx.fillRect(cx - 15, dy + 5, 4, fontSize);
          ctx.fillStyle = '#2c3e50';
        }
            
        const lineHeight = Math.floor(fontSize * 1.6);
        dy = wrapText(ctx, node.val, cx, dy, contentW, lineHeight, 10000, true) + (isHeader ? 20 : 15);
            
      } else if (node.type === 'i' && !node.error && node.img) {
        // 绘制预加载的图片
        // 居中显示
        const dx = cx + (contentW - node.dw) / 2;
            
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.1)'; ctx.shadowBlur = 15; ctx.shadowOffsetY = 5;
        // 绘制图片 (圆角效果)
        roundRect(ctx, dx, dy, node.dw, node.dh, 8); 
        ctx.shadowColor = 'transparent'; // clip 前清除阴影以免影响性能
        ctx.clip();
        ctx.drawImage(node.img, dx, dy, node.dw, node.dh);
        ctx.restore();
            
        dy += node.dh + 25;
      }
    }

    // Footer
    dy += 30;
    ctx.fillStyle = '#aaa'; ctx.font = `12px "${font}"`; ctx.textAlign = 'center';
    ctx.fillText('mcmod.cn | Powered by Koishi', width / 2, canvasH - 15);

    return canvas.toBuffer('image/png');
  }
  // ================= 渲染：作者卡片 (macOS 风格) =================
  // ================= 渲染：作者卡片 (macOS 风格) =================
  async function drawAuthorCard(url) {
    const uid = url.match(/author\/(\d+)/)?.[1] || 'Unknown';
    
    // 1. 获取数据
    const res = await fetchWithTimeout(url, { headers: getHeaders() });
    const html = await res.text();
    const $ = cheerio.load(html);

    const username = cleanText($('.author-name h5').text()) || $('title').text().split('-')[0].trim();
    const subname = $('.author-name .subname p').map((i, el) => $(el).text().trim()).get().join(' / ');
    const avatarUrl = fixUrl($('.author-user-avatar img').attr('src'));
    const bio = cleanText($('.author-content .text').text()) || '（暂无简介）';
    
    // 统计数据
    const pageInfo: { views?: string; createDate?: string; lastEdit?: string; editCount?: string } = {};
    const fullText = $('body').text().replace(/\s+/g, ' '); 
    
    function extractStat(regex) {
      const m = fullText.match(regex);
      if (m && m[1] && m[1].length < 20) return m[1].trim();
      return null;
    }

    pageInfo.views = extractStat(/浏览量[：:]\s*([\d,]+)/);
    pageInfo.createDate = extractStat(/创建日期[：:]\s*(\d{4}-\d{2}-\d{2}|\d+年前|\d+个月前|\d+天前)/);
    pageInfo.lastEdit = extractStat(/最后编辑[：:]\s*(\d{4}-\d{2}-\d{2}|\d+年前|\d+个月前|\d+天前)/);
    pageInfo.editCount = extractStat(/编辑次数[：:]\s*(\d+)/);
    
    let favCount = '0';
    const favEl = $('.author-fav .nums, .common-fuc-group li.like .nums, .fav-count');
    if (favEl.length) {
      favCount = favEl.attr('title') || favEl.text().trim() || '0';
    }
    if (favCount === '0') {
      const favMatch = fullText.match(/收藏\s*(\d+)/);
      if (favMatch) favCount = favMatch[1];
    }

    const stats = [];
    if (pageInfo.views) stats.push({ l: '浏览量', v: pageInfo.views });
    if (pageInfo.createDate) stats.push({ l: '创建日期', v: pageInfo.createDate });
    if (pageInfo.lastEdit) stats.push({ l: '最后编辑', v: pageInfo.lastEdit });
    if (pageInfo.editCount) stats.push({ l: '编辑次数', v: pageInfo.editCount });
    if (favCount) stats.push({ l: '收藏', v: favCount });

    const links = [];
    $('.author-link .common-link-icon-list a, .common-link-icon-frame a').each((i, el) => {
      const h = $(el).attr('href');
      let n = $(el).attr('data-original-title') || $(el).text().trim();
      if (!n && h) {
        if(h.includes('github')) n='GitHub'; 
        else if(h.includes('bilibili')) n='Bilibili';
        else if(h.includes('curseforge')) n='CurseForge';
        else if(h.includes('modrinth')) n='Modrinth';
        else if(h.includes('mcbbs')) n='MCBBS';
        else n='Link';
      }
      if (n && h && !links.some(l => l.n === n)) links.push({ n, h });
    });

    // 列表抓取 - 优先使用特定类名，因为它们更稳定
    const teams = [];
    const projects = [];
    const partners = [];

    // 辅助函数：从容器中提取列表项
    function extractListItems(container, targetList, isProject = false) {
      // 增加 .block 选择器以匹配 div.block (用于参与项目)
      container.find('li.block, .block, .row > div').each((i, el) => {
        const n = cleanText($(el).find('.name a, .name, h4').first().text());
        if (!n) return;
        const m = fixUrl($(el).find('img').attr('src'));
        // 增加 .count 选择器 (用于相关作者的合作次数)
        const r = cleanText($(el).find('.position, .meta, .count').text());
        // 获取类型标签 (模组/整合包等)
        let t = '';
        if (isProject) {
          const badge = $(el).find('.badge, .badge-mod, .badge-modpack').first().text().trim();
          if (badge) t = badge;
        }
        if (!targetList.some(x => x.n === n)) {
          targetList.push({ n, m, r, t });
        }
      });
    }

    // 1. 尝试特定类名 (根据用户提供的 HTML 结构修正)
    extractListItems($('.author-member .list, .author-team .list'), teams, false);
    extractListItems($('.author-mods .list'), projects, true);
    extractListItems($('.author-partner .list, .author-users .list'), partners, false);

    // 2. 如果没抓到，尝试通用抓取 (遍历所有 block/panel)
    if (teams.length === 0 || projects.length === 0 || partners.length === 0) {
      $('.common-card-layout, .panel, .block').each((i, el) => {
        const title = $(el).find('.head, .panel-heading, h3, h4').text().trim();
        if (teams.length === 0 && title.includes('参与团队')) extractListItems($(el), teams);
        if (projects.length === 0 && (title.includes('参与项目') || title.includes('发布的模组'))) extractListItems($(el), projects);
        if (partners.length === 0 && (title.includes('相关作者') || title.includes('合作者'))) extractListItems($(el), partners);
      });
    }

    // 2. 布局计算
    const width = 800;
    const font = GLOBAL_FONT_FAMILY;
    const padding = 40;
    const windowMargin = 20;
    const contentW = width - windowMargin*2 - padding*2; // 实际内容宽度
    
    // 严格计算高度
    let cursorY = 60; // Initial padding inside window
    
    // Avatar area
    cursorY += 100 + 40; // Avatar(100) + gap(40)
    
    // Stats Grid
    if (stats.length > 0) {
      cursorY += 80 + 30; // StatH(80) + gap(30)
    }
    
    // Links
    if (links.length > 0) {
      // Simulate link wrapping
      const tempC = createCanvas(100,100);
      const tempCtx = tempC.getContext('2d');
      tempCtx.font = `bold 14px "${font}"`;
        
      let lx = 0;
      let ly = 0;
      let rowH = 34;
        
      links.forEach(l => {
        const lw = tempCtx.measureText(l.n).width + 30;
        if (lx + lw > contentW) {
          lx = 0;
          ly += 45; // Line gap
        }
        lx += lw + 10;
      });
      cursorY += ly + rowH + 60; // + gap
    }
    
    // Lists Calculation Helper
    function calcSectionHeight(items, itemH, cols) {
      if (!items.length) return 0;
      const rows = Math.ceil(items.length / cols);
      // Title(35) + Rows * (ItemH + 15) + BottomGap(30)
      return 35 + rows * (itemH + 15) + 30;
    }
    
    cursorY += calcSectionHeight(teams, 70, 3);
    cursorY += calcSectionHeight(projects, 90, 2);
    cursorY += calcSectionHeight(partners, 100, 5);
    
    // Bio
    let bioH = 0;
    if (bio && bio !== '（暂无简介）') {
      const tempC = createCanvas(100,100);
      const tempCtx = tempC.getContext('2d');
      tempCtx.font = `16px "${font}"`;
      // Title(35)
      cursorY += 35;
      // Content
      bioH = wrapText(tempCtx, bio, 0, 0, contentW - 40, 26, 1000, false);
      cursorY += bioH + 40 + 60; // Padding inside rect(40) + BottomGap(60)
    }
    
    // Footer
    cursorY += 30;
    
    const windowH = cursorY;
    const totalH = windowH + windowMargin*2;

    const canvas = createCanvas(width, totalH);
    const ctx = canvas.getContext('2d');
    
    // 3. 绘制背景 (使用微软 Bing 每日图片/自然风格)
    try {
      // 使用 Bing 每日图片 API (1920x1080)
      const bgUrl = 'https://bing.biturl.top/?resolution=1920&format=image&index=0&mkt=zh-CN';
      const bgImg = await loadImage(bgUrl);
        
      // 保持比例填充
      const r = Math.max(width / bgImg.width, totalH / bgImg.height);
      const dw = bgImg.width * r;
      const dh = bgImg.height * r;
      const dx = (width - dw) / 2;
      const dy = (totalH - dh) / 2;
        
      ctx.drawImage(bgImg, dx, dy, dw, dh);
        
      // 叠加一层模糊遮罩或颜色，保证文字可读性 (虽然有亚克力板，但背景太花也不好)
      // 这里不模糊背景本身（Canvas模糊开销大），而是加一层半透明遮罩
      ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
      ctx.fillRect(0, 0, width, totalH);
        
    } catch (e) {
      // 失败回退到渐变
      const grad = ctx.createLinearGradient(0, 0, width, totalH);
      grad.addColorStop(0, '#a18cd1');
      grad.addColorStop(1, '#fbc2eb');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, totalH);
    }
    
    // 4. 绘制 Acrylic 窗口
    const windowW = width - windowMargin*2;
    
    ctx.save();
    // 窗口阴影
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 20;
    
    // 窗口背景 (40% Acrylic - 模拟)
    // 使用白色半透明 + 背景模糊效果 (Canvas 无法直接 backdrop-filter，只能通过叠加半透明白)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'; // 提高不透明度以遮盖背景杂乱
    roundRect(ctx, windowMargin, windowMargin, windowW, windowH, 20);
    ctx.fill();
    ctx.restore();
    
    // 窗口边框
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, windowMargin, windowMargin, windowW, windowH, 20);
    ctx.stroke();
    
    // 5. 窗口控件 (Traffic Lights)
    const controlY = windowMargin + 20;
    const controlX = windowMargin + 20;
    const controlR = 6;
    const controlGap = 20;
    
    ctx.fillStyle = '#ff5f56'; // Red
    ctx.beginPath(); ctx.arc(controlX, controlY, controlR, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ffbd2e'; // Yellow
    ctx.beginPath(); ctx.arc(controlX + controlGap, controlY, controlR, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#27c93f'; // Green
    ctx.beginPath(); ctx.arc(controlX + controlGap*2, controlY, controlR, 0, Math.PI*2); ctx.fill();
    
    // 6. 内容绘制
    // 重置 cursorY 到窗口内部起始位置
    cursorY = windowMargin + 60;
    const contentX = windowMargin + padding;
    
    // Header: Avatar & Name
    const avatarSize = 100;
    
    // Avatar
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.1)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(contentX + avatarSize/2, cursorY + avatarSize/2, avatarSize/2, 0, Math.PI*2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.clip();
    
    if (avatarUrl) {
      try {
        const img = await loadImage(avatarUrl);
        ctx.drawImage(img, contentX, cursorY, avatarSize, avatarSize);
      } catch(e) {
        ctx.fillStyle = '#ddd'; ctx.fill();
      }
    } else {
      ctx.fillStyle = '#ddd'; ctx.fill();
    }
    ctx.restore();
    
    // Name & UID
    const textX = contentX + avatarSize + 30;
    ctx.fillStyle = '#333';
    ctx.font = `bold 40px "${font}"`;
    ctx.textBaseline = 'top';
    ctx.fillText(username, textX, cursorY + 10);
    
    // UID Chip
    const uidText = `UID: ${uid}`;
    ctx.font = `bold 14px "${font}"`;
    const uidW = ctx.measureText(uidText).width + 20;
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    roundRect(ctx, textX, cursorY + 60, uidW, 24, 12);
    ctx.fill();
    ctx.fillStyle = '#666';
    ctx.fillText(uidText, textX + 10, cursorY + 64);

    // Subname (Alias)
    if (subname) {
      ctx.fillStyle = '#999';
      ctx.font = `14px "${font}"`;
      // 绘制在 UID 下方，稍微留点间距
      ctx.fillText(subname, textX, cursorY + 95);
    }
    
    cursorY += avatarSize + 40;
    
    // Stats Grid
    if (stats.length > 0) {
      const statW = (contentW - (stats.length-1)*15) / stats.length;
      const statH = 80;
        
      stats.forEach((s, i) => {
        const sx = contentX + i * (statW + 15);
            
        // Card bg
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        roundRect(ctx, sx, cursorY, statW, statH, 12);
        ctx.fill();
            
        // Label
        ctx.textAlign = 'center';
        ctx.fillStyle = '#666';
        ctx.font = `14px "${font}"`;
        ctx.fillText(s.l, sx + statW/2, cursorY + 15);
            
        // Value
        ctx.fillStyle = '#333';
        ctx.font = `bold 20px "${font}"`;
        // Auto scale font if too long
        let fontSize = 20;
        while (ctx.measureText(s.v).width > statW - 10 && fontSize > 10) {
          fontSize--;
          ctx.font = `bold ${fontSize}px "${font}"`;
        }
        ctx.fillText(s.v, sx + statW/2, cursorY + 45);
      });
      ctx.textAlign = 'left';
      cursorY += statH + 30;
    }
    
    // Links
    if (links.length > 0) {
      let lx = contentX;
      let ly = cursorY;
      links.forEach(l => {
        ctx.font = `bold 14px "${font}"`;
        const lw = ctx.measureText(l.n).width + 30;
        if (lx + lw > contentX + contentW) {
          lx = contentX;
          ly += 45;
        }
            
        ctx.fillStyle = '#fff';
        ctx.shadowColor = 'rgba(0,0,0,0.05)';
        ctx.shadowBlur = 5;
        roundRect(ctx, lx, ly, lw, 34, 17);
        ctx.fill();
        ctx.shadowBlur = 0;
            
        ctx.fillStyle = '#333';
        ctx.fillText(l.n, lx + 15, ly + 8);
            
        lx += lw + 10;
      });
      cursorY = ly + 60;
    }
    
    // Helper for Lists
    async function drawSection(title, items, itemH, cols, renderItem) {
      if (!items.length) return;
        
      ctx.fillStyle = '#333';
      ctx.font = `bold 22px "${font}"`;
      ctx.fillText(title, contentX, cursorY);
      cursorY += 35;
        
      const itemW = (contentW - (cols-1)*15) / cols;
        
      for (let i = 0; i < items.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const ix = contentX + col * (itemW + 15);
        const iy = cursorY + row * (itemH + 15);
            
        // Item Card
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        roundRect(ctx, ix, iy, itemW, itemH, 12);
        ctx.fill();
            
        await renderItem(items[i], ix, iy, itemW, itemH);
      }
        
      cursorY += Math.ceil(items.length / cols) * (itemH + 15) + 30;
    }
    
    // Draw Lists
    await drawSection('参与团队', teams, 70, 3, async (item, x, y, w, h) => {
      if (item.m) {
        try {
          const img = await loadImage(item.m);
          ctx.drawImage(img, x + 10, y + 15, 40, 40);
        } catch(e) {}
      }
      ctx.fillStyle = '#333'; ctx.font = `bold 16px "${font}"`;
      ctx.fillText(item.n, x + 60, y + 15);
      if (item.r) {
        ctx.fillStyle = '#666'; ctx.font = `12px "${font}"`;
        ctx.fillText(item.r, x + 60, y + 40);
      }
    });
    
    await drawSection('参与项目', projects, 90, 2, async (item, x, y, w, h) => {
      if (item.m) {
        try {
          const img = await loadImage(item.m);
          ctx.drawImage(img, x + 10, y + 15, 100, 60);
        } catch(e) {}
      }
        
      // 绘制类型标签 (模组/整合包)
      let nameOffsetX = 120;
      if (item.t) {
        ctx.font = `bold 12px "${font}"`;
        const tagText = item.t;
        const tagW = ctx.measureText(tagText).width + 12;
        const tagH = 20;
        const tagX = x + 120;
        const tagY = y + 12;
            
        // 根据类型设置颜色：模组=绿色，整合包=橙色，其他=灰色
        let tagBg = '#999';
        if (tagText.includes('模组')) tagBg = '#2ecc71';
        else if (tagText.includes('整合包')) tagBg = '#e67e22';
        else if (tagText.includes('资料')) tagBg = '#3498db';
            
        ctx.fillStyle = tagBg;
        roundRect(ctx, tagX, tagY, tagW, tagH, 4);
        ctx.fill();
            
        ctx.fillStyle = '#fff';
        ctx.fillText(tagText, tagX + 6, tagY + 4);
            
        nameOffsetX = 120 + tagW + 8;
      }
        
      // 去掉名称中的类型前缀（避免与标签重复）
      let displayName = item.n;
      if (item.t) {
        // 移除开头的 "模组"、"整合包" 等前缀
        displayName = displayName.replace(/^(模组|整合包|资料)\s*/g, '').trim();
      }
        
      ctx.fillStyle = '#333'; ctx.font = `bold 16px "${font}"`;
      wrapText(ctx, displayName, x + nameOffsetX, y + 15, w - nameOffsetX - 10, 20, 2, true);
      if (item.r) {
        ctx.fillStyle = '#666'; ctx.font = `12px "${font}"`;
        ctx.fillText(item.r, x + 120, y + 60);
      }
    });

    await drawSection('相关作者', partners, 100, 5, async (item, x, y, w, h) => {
      const iconSize = 50;
      if (item.m) {
        try {
          const img = await loadImage(item.m);
          ctx.save();
          ctx.beginPath(); ctx.arc(x + w/2, y + 25, iconSize/2, 0, Math.PI*2); ctx.clip();
          ctx.drawImage(img, x + w/2 - iconSize/2, y, iconSize, iconSize);
          ctx.restore();
        } catch(e) {}
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = '#333'; ctx.font = `14px "${font}"`;
      wrapText(ctx, item.n, x + w/2, y + 60, w - 10, 18, 2, true);
      ctx.textAlign = 'left';
    });
    
    // Bio
    if (bio && bio !== '（暂无简介）') {
      ctx.fillStyle = '#333';
      ctx.font = `bold 22px "${font}"`;
      ctx.fillText('简介', contentX, cursorY);
      cursorY += 35;
        
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
        
      roundRect(ctx, contentX, cursorY, contentW, bioH + 40, 12);
      ctx.fill();
        
      ctx.fillStyle = '#444';
      ctx.font = `16px "${font}"`;
      wrapText(ctx, bio, contentX + 20, cursorY + 20, contentW - 40, 26, 1000, true);
        
      cursorY += bioH + 60;
    }
    
    // Footer
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.font = `12px "${font}"`;
    ctx.textAlign = 'center';
    ctx.fillText('mcmod.cn | Powered by Koishi', width/2, totalH - 15);

    return canvas.toBuffer('image/png');
  }
  // ================= 普通用户卡片 (Center Card) =================
  async function drawCenterCard(uid, logger) { return drawCenterCardImpl(uid, logger); }
  async function drawCenterCardImpl(uid, logger) {
    const centerUrl = `${CENTER_URL}/${uid}/`;
    const bbsUrl = `https://bbs.mcmod.cn/center/${uid}/`; 
    const homeApiUrl = `${CENTER_URL}/frame/CenterHome/`;
    const commentApiUrl = `${CENTER_URL}/frame/CenterComment/`;
    const chartApiUrl = `${CENTER_URL}/object/UserHistoryChartData/`;
    
    const params = new URLSearchParams(); params.append('uid', uid);
    const currentYear = new Date().getFullYear();
    const chartParams = new URLSearchParams(); chartParams.append('data', JSON.stringify({ uid: parseInt(uid), year: currentYear }));
    const apiHeaders = { ...getHeaders(centerUrl), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };

    let mainHtml='', homeJson=null, commentJson=null, chartJson=null, bbsHtml='';
    
    // 1. 并行获取所有数据
    try {
      const results = await Promise.allSettled([
        fetchWithTimeout(centerUrl, { headers: getHeaders() }),
        fetchWithTimeout(homeApiUrl, { method: 'POST', headers: apiHeaders, body: params }),
        fetchWithTimeout(commentApiUrl, { method: 'POST', headers: apiHeaders, body: params }),
        fetchWithTimeout(chartApiUrl, { method: 'POST', headers: apiHeaders, body: chartParams }),
        fetchWithTimeout(bbsUrl, { headers: getHeaders() })
      ]);

      if(results[0].status === 'fulfilled') mainHtml = await results[0].value.text();
      if(results[1].status === 'fulfilled' && results[1].value.ok) try { homeJson = await results[1].value.json(); } catch(e){}
      if(results[2].status === 'fulfilled' && results[2].value.ok) try { commentJson = await results[2].value.json(); } catch(e){}
      if(results[3].status === 'fulfilled' && results[3].value.ok) try { chartJson = await results[3].value.json(); } catch(e){}
      if(results[4].status === 'fulfilled' && results[4].value.ok) bbsHtml = await results[4].value.text();
    } catch (e) {
      logger.error(`[Card] 数据获取部分失败: ${e.message}`);
    }

    // 2. 解析 Center 主站数据
    const $main = cheerio.load(mainHtml || '');
    const header = $main('.center-header');
    const username = cleanText(header.find('.user-un').text()) || 'User';
    const levelText = cleanText(header.find('.user-lv').text()) || 'Lv.?';
    const signature = cleanText(header.find('.user-sign').text()) || '（无签名）';
    let avatarUrl = fixUrl(header.find('.user-icon-img img').attr('src'));
    
    let bannerUrl = null;
    $main('style').each((i, el) => {
      const styleText = $main(el).html() || '';
      const bodyBgMatch = styleText.match(/body\s*\{\s*background\s*:\s*url\(([^)]+)\)/i);
      if (bodyBgMatch && bodyBgMatch[1] && (!styleText.includes('.copyright') || styleText.includes('body{background'))) {
        bannerUrl = fixUrl(bodyBgMatch[1].replace(/['"]/g, ''));
      }
    });
    if (!bannerUrl) bannerUrl = fixUrl((header.attr('style') || '').match(/url\((.*?)\)/)?.[1]?.replace(/['"]/g, ''));

    // 3. 解析 BBS 数据
    const bbsData = { medals: [], points: [], detailed: [], profile: [], times: [] };
    if (bbsHtml) {
      const $bbs = cheerio.load(bbsHtml);
      if (!avatarUrl) avatarUrl = fixUrl($bbs('.icn.avt img').attr('src'));

      // 勋章墙 (修复：$(el) -> $bbs(el))
      $bbs('.md_ctrl img').each((i, el) => {
        const src = fixUrl($bbs(el).attr('src'));
        const name = $bbs(el).attr('alt') || $bbs(el).attr('title') || '勋章';
        if(src) bbsData.medals.push({ src, name });
      });

      // 积分统计 (修复：$(el) -> $bbs(el))
      $bbs('#psts .pf_l li').each((i, el) => {
        const label = cleanText($bbs(el).find('em').text());
        const val = cleanText($bbs(el).text()).replace(label, '').trim();
        if (label && val) bbsData.points.push({ l: label, v: val });
      });

      // 详细贡献 (修复：$(el) -> $bbs(el))
      $bbs('.u_profile .bbda.pbm.mbm li p').each((i, el) => {
        const txt = $bbs(el).text();
        if (txt.includes('：') && ($bbs(el).find('.green').length > 0 || txt.includes('/'))) {
          const label = txt.split('：')[0].trim();
          const add = cleanText($bbs(el).find('.green').text()) || '0';
          const edit = cleanText($bbs(el).find('.blue').text()) || '0';
          if (label && !label.includes('以下数据')) {
            bbsData.detailed.push({ l: label, add, edit });
          }
        }
      });

      // 个人档案 (修复：$(el) -> $bbs(el))
      $bbs('.u_profile .pf_l.cl li').each((i, el) => {
        const label = cleanText($bbs(el).find('em').text());
        const val = cleanText($bbs(el).text()).replace(label, '').trim();
        if (label && val) bbsData.profile.push({ l: label, v: val });
      });

      // 完整时间统计 (修复：$(el) -> $bbs(el))
      $bbs('#pbbs li').each((i, el) => {
        const label = cleanText($bbs(el).find('em').text());
        const val = cleanText($bbs(el).text()).replace(label, '').trim();
        if (label && val) bbsData.times.push({ l: label, v: val });
      });
    }

    // 4. 解析原有 API 数据
    const statsMap: { group?: string; edits?: string; words?: string; comments?: string; tutorials?: string; reg?: string } = {};
    if (homeJson?.html) {
      const $h = cheerio.load(homeJson.html);
      $h('li').each((i, el) => {
        const t = cleanText($h(el).find('.title').text());
        const v = cleanText($h(el).find('.text').text());
        if(t&&v) {
          if(t.includes('用户组')) statsMap.group = v;
          else if(t.includes('编辑次数')) statsMap.edits = v;
          else if(t.includes('编辑字数')) statsMap.words = v;
          else if(t.includes('短评')) statsMap.comments = v;
          else if(t.includes('教程')) statsMap.tutorials = v;
          else if(t.includes('注册')) statsMap.reg = v; 
        }
      });
    }
    
    // 基础统计列表
    const basicStats = [
      { l: '用户组', v: statsMap.group || '未知' }, { l: '总编辑次数', v: statsMap.edits || '0' },
      { l: '总编辑字数', v: statsMap.words || '0' }, { l: '总短评数', v: statsMap.comments || '0' },
      { l: '个人教程', v: statsMap.tutorials || '0' }
    ];
    // 如果 BBS 数据里没有注册时间，则从 API 补充
    if (!bbsData.times.some(t => t.l.includes('注册')) && statsMap.reg) {
      bbsData.times.unshift({ l: '注册时间', v: statsMap.reg });
    }

    const reactions = [];
    if (commentJson?.html) {
      const $c = cheerio.load(commentJson.html);
      $c('li').each((i, el) => {
        const t = cleanText($c(el).text());
        const m = t.match(/被评[“"'](.+?)[”"']\s*[:：]\s*([\d,]+)/);
        if(m) reactions.push({ l: m[1], c: m[2] });
      });
    }

    const activityMap: Record<string, number> = {};
    if (chartJson?.chartdata?.total) {
      chartJson.chartdata.total.forEach(item => {
        if(Array.isArray(item) && typeof item[1] === 'number') activityMap[item[0]] = item[1];
      });
    }

    // ================= 绘图逻辑 =================
    const width = 800;
    const font = GLOBAL_FONT_FAMILY;
    
    const bannerH = 160;
    const headerH = 140; 
    const cardOverlap = 40;
    const padding = 20;
    const gap = 15;
    
    let currentY = bannerH - cardOverlap + headerH + padding;

    // BBS 勋章墙
    let medalsH = 0;
    if (bbsData.medals.length > 0) {
      const rows = Math.ceil(bbsData.medals.length / 12);
      medalsH = 50 + rows * 40 + 20;
      currentY += medalsH + gap;
    }

    // BBS 积分
    let pointsH = 0;
    if (bbsData.points.length > 0) {
      const rows = Math.ceil(bbsData.points.length / 4);
      pointsH = 50 + rows * 60 + 20;
      currentY += pointsH + gap;
    }

    // BBS 详细贡献
    let detailedH = 0;
    if (bbsData.detailed.length > 0) {
      const rows = Math.ceil(bbsData.detailed.length / 2);
      detailedH = 50 + rows * 50 + 20;
      currentY += detailedH + gap;
    }

    // 基础统计
    const statsH = 180;
    currentY += statsH + gap;

    // 表态
    let reactionSectionH = 80;
    if (reactions.length > 0) {
      const tempC = createCanvas(100, 100);
      const tempCtx = tempC.getContext('2d');
      tempCtx.font = `14px "${font}"`;
      let rx = 50, lines = 1;
      reactions.forEach(item => {
        const t = `${item.l}: ${item.c}`;
        const w = tempCtx.measureText(t).width + 30;
        if (rx + w > width - 50) { rx = 50; lines++; }
        rx += w + 10;
      });
      reactionSectionH = 50 + (lines * 35) + 20; 
    }
    currentY += reactionSectionH + gap;

    // 热力图
    const mapH = 200;
    currentY += mapH + gap;

    // 时间信息区域高度
    let timesH = 0;
    if (bbsData.times.length > 0) {
      timesH = 80; 
      currentY += timesH;
    }

    const totalHeight = currentY + 30; // 底部版权留白
    const canvas = createCanvas(width, totalHeight);
    const ctx = canvas.getContext('2d');
    
    // 背景
    ctx.fillStyle = '#f0f2f5'; ctx.fillRect(0, 0, width, totalHeight);
    try {
      if (bannerUrl) {
        const img = await loadImage(bannerUrl);
        const r = Math.max(width/img.width, bannerH/img.height);
        ctx.drawImage(img, 0, 0, img.width, img.height, (width-img.width*r)/2, (bannerH-img.height*r)/2, img.width*r, img.height*r);
      } else { ctx.fillStyle = '#3498db'; ctx.fillRect(0, 0, width, bannerH); }
    } catch(e) { ctx.fillStyle = '#3498db'; ctx.fillRect(0, 0, width, bannerH); }
    
    const overlay = ctx.createLinearGradient(0, 80, 0, bannerH);
    overlay.addColorStop(0, 'rgba(0,0,0,0)'); overlay.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = overlay; ctx.fillRect(0, 0, width, bannerH);

    // Header
    const cardTop = bannerH - cardOverlap;
    ctx.shadowColor = 'rgba(0,0,0,0.1)'; ctx.shadowBlur = 10;
    ctx.fillStyle = '#fff'; roundRect(ctx, 20, cardTop, width - 40, headerH, 10); ctx.fill(); ctx.shadowBlur = 0;
    
    const avX = 50, avY = cardTop - 30;
    ctx.beginPath(); ctx.arc(avX + 50, avY + 50, 54, 0, Math.PI*2); ctx.fillStyle = '#fff'; ctx.fill();
    if (avatarUrl) { try { const img = await loadImage(avatarUrl); ctx.save(); ctx.beginPath(); ctx.arc(avX+50, avY+50, 50, 0, Math.PI*2); ctx.clip(); ctx.drawImage(img, avX, avY, 100, 100); ctx.restore(); } catch(e) {} }
    
    const nameX = 180, nameY = cardTop + 20;
    ctx.textBaseline = 'top'; ctx.fillStyle = '#333'; ctx.font = `bold 32px "${font}"`; ctx.fillText(username, nameX, nameY);
    const nameW = ctx.measureText(username).width;
    
    ctx.fillStyle = '#f39c12'; roundRect(ctx, nameX+nameW+15, nameY+5, 50, 24, 4); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold 16px "${font}"`; ctx.fillText(levelText, nameX+nameW+22, nameY+8);
    
    ctx.textAlign = 'right'; ctx.fillStyle = '#999'; ctx.font = `bold 20px "${font}"`; 
    ctx.fillText(`UID: ${uid}`, width - 50, nameY + 10); ctx.textAlign = 'left';
    
    const mcid = bbsData.profile.find(p => p.l === 'MCID')?.v;
    const subText = mcid ? `MCID: ${mcid}  |  ${signature}` : signature;
    ctx.fillStyle = '#666'; ctx.font = `16px "${font}"`; 
    wrapText(ctx, subText, nameX, nameY + 50, width - 250, 24, 2);

    let dy = cardTop + headerH + padding;

    // 绘制 BBS 勋章
    if (bbsData.medals.length > 0) {
      ctx.fillStyle='#fff'; roundRect(ctx, 20, dy, width-40, medalsH, 10); ctx.fill();
      ctx.fillStyle='#333'; ctx.font=`bold 18px "${font}"`; ctx.fillText('勋章墙', 40, dy+25);
      ctx.strokeStyle='#eee'; ctx.beginPath(); ctx.moveTo(40, dy+50); ctx.lineTo(width-40, dy+50); ctx.stroke();
        
      let mx = 40, my = dy + 60;
      const iconSize = 32;
      for (const m of bbsData.medals) {
        try {
          const img = await loadImage(m.src);
          ctx.drawImage(img, mx, my, iconSize, iconSize);
        } catch(e) {}
        mx += iconSize + 15;
        if (mx > width - 80) { mx = 40; my += iconSize + 10; }
      }
      dy += medalsH + gap;
    }

    // 绘制 BBS 积分
    if (bbsData.points.length > 0) {
      ctx.fillStyle='#fff'; roundRect(ctx, 20, dy, width-40, pointsH, 10); ctx.fill();
      ctx.fillStyle='#333'; ctx.font=`bold 18px "${font}"`; ctx.fillText('积分统计', 40, dy+25);
      ctx.beginPath(); ctx.moveTo(40, dy+50); ctx.lineTo(width-40, dy+50); ctx.stroke();
        
      const colW = (width-80) / 4;
      bbsData.points.forEach((p, i) => {
        const col = i % 4; const row = Math.floor(i / 4);
        const px = 40 + col * colW;
        const py = dy + 70 + row * 60;
        ctx.fillStyle = '#999'; ctx.font = `12px "${font}"`; ctx.fillText(p.l, px, py);
        ctx.fillStyle = '#333'; ctx.font = `bold 20px "${font}"`; ctx.fillText(p.v, px, py + 20);
      });
      dy += pointsH + gap;
    }

    // 绘制 BBS 详细贡献
    if (bbsData.detailed.length > 0) {
      ctx.fillStyle='#fff'; roundRect(ctx, 20, dy, width-40, detailedH, 10); ctx.fill();
      ctx.fillStyle='#333'; ctx.font=`bold 18px "${font}"`; ctx.fillText('详细贡献', 40, dy+25);
      ctx.beginPath(); ctx.moveTo(40, dy+50); ctx.lineTo(width-40, dy+50); ctx.stroke();
        
      const colW = (width-80) / 2;
      bbsData.detailed.forEach((d, i) => {
        const col = i % 2; const row = Math.floor(i / 2);
        const dx = 40 + col * colW;
        const dyLoc = dy + 70 + row * 50;
        ctx.fillStyle = '#555'; ctx.font = `16px "${font}"`; ctx.fillText(d.l, dx, dyLoc);
        ctx.fillStyle = '#2ecc71'; ctx.font = `bold 16px "${font}"`; 
        const addTxt = `+${d.add}`; const addW = ctx.measureText(addTxt).width;
        ctx.fillText(addTxt, dx + 120, dyLoc);
        ctx.fillStyle = '#3498db'; 
        const editTxt = `~${d.edit}`;
        ctx.fillText(editTxt, dx + 120 + addW + 15, dyLoc);
      });
      dy += detailedH + gap;
    }

    // 绘制 基础统计
    ctx.fillStyle='#fff'; roundRect(ctx, 20, dy, width-40, statsH, 10); ctx.fill();
    ctx.fillStyle='#333'; ctx.font=`bold 18px "${font}"`; ctx.fillText('基础统计', 40, dy+25);
    ctx.beginPath(); ctx.moveTo(40, dy+50); ctx.lineTo(width-40, dy+50); ctx.stroke();
    const colW = (width-40) / 3;
    basicStats.forEach((s, i) => {
      const col = i%3, row = Math.floor(i/3);
      const cx = 20 + col * colW;
      const cy = dy + 70 + row * 50;
      ctx.fillStyle='#999'; ctx.font=`14px "${font}"`; ctx.fillText(s.l, cx+30, cy);
      ctx.fillStyle='#333'; ctx.font=`bold 16px "${font}"`; ctx.fillText(s.v, cx+30, cy+25);
    });
    dy += statsH + gap;

    // 绘制 表态
    ctx.fillStyle='#fff'; roundRect(ctx, 20, dy, width-40, reactionSectionH, 10); ctx.fill();
    ctx.fillStyle='#333'; ctx.font=`bold 18px "${font}"`; ctx.fillText('表态统计', 40, dy+25);
    ctx.beginPath(); ctx.moveTo(40, dy+50); ctx.lineTo(width-40, dy+50); ctx.stroke();
    if (reactions.length) {
      let rx = 50, ry = dy + 75; ctx.font = `14px "${font}"`;
      reactions.forEach(r=>{
        const t=`${r.l}: ${r.c}`; const w=ctx.measureText(t).width+30;
        if(rx+w>width-50){ rx=50; ry+=35; }
        ctx.fillStyle='#f0f2f5'; roundRect(ctx,rx,ry-18,w,28,14); ctx.fill();
        ctx.fillStyle='#e74c3c'; ctx.beginPath(); ctx.arc(rx+10,ry-4,3,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='#555'; ctx.fillText(t,rx+20,ry-10); rx+=w+10;
      });
    } else {
      ctx.fillStyle='#ccc'; ctx.font=`14px "${font}"`; ctx.fillText('暂无表态', 50, dy+75);
    }
    dy += reactionSectionH + gap;

    // 绘制 热力图
    ctx.fillStyle='#fff'; roundRect(ctx, 20, dy, width-40, mapH, 10); ctx.fill();
    ctx.fillStyle='#333'; ctx.font=`bold 18px "${font}"`; ctx.fillText(`活跃度 (${currentYear})`, 40, dy+25);
    ctx.beginPath(); ctx.moveTo(40, dy+50); ctx.lineTo(width-40, dy+50); ctx.stroke();
    const box=11, g=3, sx=50, sy=dy+70;
    const start = new Date(currentYear, 0, 1);
    let curr = new Date(currentYear, 0, 1);
    const end = new Date(currentYear, 11, 31);
    while(curr<=end) {
      const doy = Math.floor((curr.getTime() - start.getTime()) / 86400000);
      const c = Math.floor((doy + start.getDay() + 6) / 7);
      const r = (curr.getDay()+6)%7;
      if(c<53) {
        const count = activityMap[curr.toISOString().split('T')[0]] || 0;
        ctx.fillStyle = count===0 ? '#ebedf0' : count<=2 ? '#9be9a8' : count<=5 ? '#40c463' : '#216e39';
        roundRect(ctx, sx+c*(box+g), sy+r*(box+g), box, box, 2); ctx.fill();
      }
      curr.setDate(curr.getDate()+1);
    }
    dy += mapH + gap;

    // 绘制详细时间列表
    if (bbsData.times.length > 0) {
      ctx.fillStyle = '#666'; ctx.font = `12px "${font}"`;
      let tx = 40, ty = dy;
        
      bbsData.times.forEach(t => {
        const str = `${t.l}: ${t.v}`;
        const w = ctx.measureText(str).width;
        if (tx + w > width - 40) {
          tx = 40; // 换行
          ty += 20;
        }
        ctx.fillText(str, tx, ty);
        tx += w + 30; // 字段间距
      });
      dy = ty + 30; // 更新总高度游标
    }
    
    // Footer
    ctx.fillStyle = '#999'; ctx.font = `12px "${font}"`; ctx.textAlign = 'center';
    ctx.fillText('mcmod.cn & bbs.mcmod.cn | Powered by Koishi | Bot By Mai_xiyu', width / 2, totalHeight - 15);

    return canvas.toBuffer('image/png');
  }

  // ================= 详情页卡片 =================
  // ================= 详情页卡片 (资料/物品/通用) =================
  // ================= 详情页卡片 (资料/物品/通用) - 深度解析版 =================
  async function createInfoCard(url, type) {
    // 1. 获取并解析页面
    const res = await fetchWithTimeout(url, { headers: getHeaders('https://search.mcmod.cn/') });
    const html = await res.text();
    const $ = cheerio.load(html);

    // --- 基础信息 ---
    // 标题：尝试从 .itemname 或 h3 获取
    let title = cleanText($('.itemname .name h5, .itemname .name').first().text());
    if (!title) title = cleanText($('title').text().split('-')[0].trim());
    
    // 来源/模组：面包屑导航倒数第三个通常是模组名
    let source = cleanText($('.common-nav .item').eq(1).text()); 
    // 或者尝试从 nav 链接判断
    if (!source) source = cleanText($('.common-nav li a[href*="/class/"]').last().text());

    // 图标：优先获取高清大图 (128x128)，其次普通图标
    let imgUrl = fixUrl($('.item-info-table img[width="128"]').attr('src'));
    if (!imgUrl) imgUrl = fixUrl($('.item-info-table img').first().attr('src'));
    if (!imgUrl) imgUrl = fixUrl($('.common-icon-text-frame img').attr('src'));

    // --- 属性列表 ---
    const props = [];
    
    // 1. 抓取右侧/下方的表格数据 (.item-data table, .item-info-table table)
    // 排除包含图片的行，只抓取文字属性
    $('table.table-bordered tr').each((i, tr) => {
      const tds = $(tr).find('td');
      if (tds.length >= 2) {
        // 可能是 <th>key</th><td>value</td> 或者 <td>key</td><td>value</td>
        let key = cleanText($(tds[0]).text()).replace(/[:：]/g, '');
        let val = cleanText($(tds[1]).text());
            
        // 过滤无效行 (如图标行)
        if (key && val && val.length > 0 && !$(tds[1]).find('img').length) {
          // 排除重复
          if (!props.some(p => p.l === key)) {
            props.push({ l: key, v: val });
          }
        }
      }
    });

    // --- 简介 ---
    // 优先 .item-content，其次 meta description
    let desc = '';
    const contentDiv = $('.item-content.common-text').first();
    if (contentDiv.length) {
      desc = cleanText(contentDiv.text());
    } else {
      desc = $('meta[name="description"]').attr('content') || '暂无简介';
    }
    // 清理 "MCmod does not have a description..." 等默认文本
    if (desc.includes('MCmod does not have a description')) desc = '暂无简介';

    // --- 相关物品 (新增) ---
    const relations = [];
    $('.common-imglist-block .common-imglist li').each((i, el) => {
      if (i >= 7) return; // 最多显示7个
      const name = $(el).attr('data-original-title') || cleanText($(el).find('.text').text());
      const icon = fixUrl($(el).find('img').attr('src'));
      if (name && icon) relations.push({ n: name, i: icon });
    });

    // ================= 绘图逻辑 =================
    const width = 800;
    const font = GLOBAL_FONT_FAMILY;
    const margin = 20;
    const winPadding = 30;
    const contentW = width - margin * 2 - winPadding * 2;

    const dummyC = createCanvas(100, 100);
    const dummy = dummyC.getContext('2d');
    dummy.font = `bold 32px "${font}"`;

    // 1. 高度计算
    // Header (Title + Source)
    let headerH = 60; 
    if (source) headerH += 30;
    
    // Content Layout: Left (Icon + Props) | Right (Desc)
    const iconSize = 100;
    const leftColW = 240; // 左侧宽度
    const rightColW = contentW - leftColW - 20; // 右侧宽度

    // Props Height
    let propsH = 0;
    if (props.length) {
      propsH = props.length * 28 + 20;
    }
    const leftH = iconSize + 20 + propsH;

    // Desc Height
    dummy.font = `16px "${font}"`;
    const descLines = wrapText(dummy, desc, 0, 0, rightColW, 26, 30, false) / 26;
    const descH = 40 + descLines * 26; // Title + Text

    // Relations Height
    let relH = 0;
    if (relations.length) {
      relH = 90; // Title + Icons
    }

    // Main Content Height (取左右最大值)
    let mainH = Math.max(leftH, descH);
    
    // Total Layout
    let cursorY = margin + 50; // Top traffic lights
    const gap = 20;

    cursorY += headerH + gap;
    cursorY += mainH + gap;
    if (relH) cursorY += relH + gap;

    const windowH = cursorY;
    const totalH = windowH + margin * 2;

    // 2. 绘制背景与窗口
    const canvas = createCanvas(width, totalH);
    const ctx = canvas.getContext('2d');

    // 背景 (Bing)
    try {
      const bgUrl = 'https://bing.biturl.top/?resolution=1920&format=image&index=0&mkt=zh-CN';
      const bgImg = await loadImage(bgUrl);
      const r = Math.max(width / bgImg.width, totalH / bgImg.height);
      ctx.drawImage(bgImg, (width - bgImg.width * r) / 2, (totalH - bgImg.height * r) / 2, bgImg.width * r, bgImg.height * r);
      ctx.fillStyle = 'rgba(0,0,0,0.1)'; ctx.fillRect(0, 0, width, totalH);
    } catch (e) {
      const grad = ctx.createLinearGradient(0, 0, 0, totalH);
      grad.addColorStop(0, '#e6dee9'); grad.addColorStop(1, '#dad4ec'); // 柔和紫灰
      ctx.fillStyle = grad; ctx.fillRect(0, 0, width, totalH);
    }

    // 窗口 (Acrylic)
    const winX = margin, winY = margin;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.2)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 20;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    roundRect(ctx, winX, winY, width - margin * 2, windowH, 16);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1;
    roundRect(ctx, winX, winY, width - margin * 2, windowH, 16); ctx.stroke();

    // 交通灯
    ['#ff5f56', '#ffbd2e', '#27c93f'].forEach((c, i) => {
      ctx.beginPath(); ctx.arc(winX + 20 + i * 25, winY + 20, 6, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
    });

    // --- 内容绘制 ---
    let dy = winY + 50;
    const cx = winX + winPadding;

    // 1. Header
    ctx.fillStyle = '#333'; ctx.font = `bold 32px "${font}"`; ctx.textBaseline = 'top';
    ctx.fillText(title, cx, dy);
    
    if (source) {
      ctx.fillStyle = '#888'; ctx.font = `bold 16px "${font}"`;
      // 绘制所属模组标签
      const tagW = ctx.measureText(source).width + 16;
      ctx.fillStyle = '#f0f0f0'; roundRect(ctx, cx, dy + 45, tagW, 26, 6); ctx.fill();
      ctx.fillStyle = '#666'; ctx.fillText(source, cx + 8, dy + 49);
    }
    dy += headerH + gap;

    // 2. Left Column (Icon + Props)
    const leftX = cx;
    let leftY = dy;
    
    // Icon
    if (imgUrl) {
      try {
        const img = await loadImage(imgUrl);
        // 保持比例绘制在 100x100 区域居中
        const r = Math.min(iconSize / img.width, iconSize / img.height);
        const dw = img.width * r, dh = img.height * r;
        ctx.drawImage(img, leftX + (iconSize - dw) / 2, leftY + (iconSize - dh) / 2, dw, dh);
      } catch(e) {
        ctx.fillStyle = '#eee'; roundRect(ctx, leftX, leftY, iconSize, iconSize, 12); ctx.fill();
      }
    }
    leftY += iconSize + 20;

    // Props
    if (props.length) {
      props.forEach(p => {
        ctx.fillStyle = '#999'; ctx.font = `12px "${font}"`;
        ctx.fillText(p.l, leftX, leftY);
            
        ctx.fillStyle = '#333'; ctx.font = `bold 14px "${font}"`;
        let v = p.v;
        if (v.length > 20) v = v.substring(0, 18) + '...';
        ctx.fillText(v, leftX, leftY + 16);
            
        leftY += 38;
      });
    }

    // 3. Right Column (Description)
    const rightX = cx + leftColW + 20;
    let rightY = dy;

    ctx.fillStyle = '#333'; ctx.font = `bold 20px "${font}"`; ctx.fillText('简介', rightX, rightY);
    ctx.fillStyle = '#3498db'; ctx.fillRect(rightX, rightY + 25, 30, 4);
    rightY += 40;

    ctx.fillStyle = '#555'; ctx.font = `16px "${font}"`;
    wrapText(ctx, desc, rightX, rightY, rightColW, 26, 30, true);
    
    // 更新 dy 到主内容下方
    dy += mainH + gap;

    // 4. Relations (Bottom)
    if (relations.length) {
      // 分割线
      ctx.strokeStyle = '#eee'; ctx.lineWidth = 1; 
      ctx.beginPath(); ctx.moveTo(cx, dy); ctx.lineTo(cx + contentW, dy); ctx.stroke();
      dy += 20;

      ctx.fillStyle = '#333'; ctx.font = `bold 18px "${font}"`; 
      ctx.fillText('相关物品', cx, dy);
        
      let rx = cx + 90;
      const rIconSize = 32;
        
      for (const r of relations) {
        try {
          const img = await loadImage(r.i);
          ctx.drawImage(img, rx, dy - 5, rIconSize, rIconSize);
        } catch(e) {
          ctx.fillStyle = '#eee'; ctx.fillRect(rx, dy - 5, rIconSize, rIconSize);
        }
            
        // 简单显示名字 tooltip 效果不太好做，这里只画图标，或者简单的名字
        // 为了美观，这里只画图标，名字太长会乱
        // ctx.fillStyle = '#666'; ctx.font = `10px "${font}"`; 
        // ctx.fillText(r.n.substring(0, 5), rx, dy + 40);

        rx += rIconSize + 15;
      }
    }

    // Footer
    ctx.fillStyle = '#aaa'; ctx.font = `12px "${font}"`; ctx.textAlign = 'center';
    ctx.fillText('mcmod.cn | Powered by Koishi', width / 2, totalH - 15);

    return canvas.toBuffer('image/png');
  }

  // ================= Koishi =================

  export const name = 'mcmod-search';
export const Config = Schema.object({
  sendLink: Schema.boolean().default(true).description('发送卡片后是否附带链接'),
  cookie: Schema.string().description('【可选】手动填写 mcmod.cn 的 Cookie'),
});

export function apply(ctx, config) {
  const logger = ctx.logger('mcmod');
  if (!initFont(config.fontPath, logger)) {}

  // 初始化 Cookie
  if (config.cookie) {
    globalCookie = config.cookie;
    logger.info('使用手动配置的 Cookie');
  } else if (config.autoCookie && cookieManager) {
    cookieManager.getCookie().then(cookie => {
      if (cookie) {
        globalCookie = cookie;
        cookieLastCheck = Date.now();
        logger.info('已自动获取 mcmod.cn Cookie');
      }
    }).catch(e => {
      logger.warn('自动获取 Cookie 失败:', e.message);
    });
  }

  // --- 状态管理 (严格隔离) ---
  function clearState(cid) {
    const state = searchStates.get(cid);
    if (state && state.timer) clearTimeout(state.timer);
    searchStates.delete(cid);
  }

  // --- 排队系统 ---
  const queue = [];
  let isProcessing = false;

  async function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;

    const { session, task } = queue.shift();
    try {
        await task();
    } catch (e) {
        logger.error('任务执行出错:', e);
        await session.send(`执行出错: ${e.message}`);
    } finally {
        isProcessing = false;
        // 稍微延迟一下，给系统喘息时间
        setTimeout(processQueue, 500);
    }
  }

  // 入队函数
  function enqueue(session, taskName, taskFunc) {
    return new Promise<void>((resolve, reject) => {
        queue.push({
            session,
            task: async () => {
                try {
                    // 如果队列较长，提示用户
                    if (queue.length > 1) {
                       // 可选：发送排队提示
                       // await session.send(`正在处理您的请求... (排队中)`);
                    }
                    await taskFunc();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }
        });
        processQueue();
    });
  }

  // 辅助：尝试撤回消息
  async function tryWithdraw(session, messageIds) {
    if (!messageIds || !messageIds.length) return;
    try {
        for (const id of messageIds) {
            await session.bot.deleteMessage(session.channelId, id);
        }
    } catch (e) { }
  }

  // --- 注册指令 ---
  const prefix = config?.prefixes?.cnmc || 'cnmc';
  const commandTypes = ['mod', 'data', 'pack', 'tutorial', 'author', 'user'];

  ctx.command(`${prefix}.help`).action(() => [
    `${prefix} <关键词>  | 默认搜索 Mod`,
    `${prefix}.mod/.data/.pack/.tutorial/.author/.user <关键词>`,
    '列表交互：输入序号查看，n 下一页，p 上一页，q 退出',
  ].join('\n'));

  commandTypes.forEach(type => {
      ctx.command(`${prefix}.${type} <keyword:text>`)
         .action(async ({ session }, keyword) => {
           if (!keyword) return '请输入关键词。';
             
             // 将搜索任务加入队列
             enqueue(session, `search-${type}`, async () => {
                 try {
                    if (config.debug) logger.debug(`[${session.userId}] 正在搜索 ${keyword} ...`);
                    
                    // 1. 尝试主搜索
                    let results = await fetchSearch(keyword, type);
                    
                    // 2. [修改] 如果主搜索为空，且类型支持，尝试备用接口
                    if (!results.length && FALLBACK_TYPE_MAP[type]) {
                        if (config.debug) logger.debug(`主搜索为空，尝试备用接口: ${type}`);
                        const fallbackResults = await fetchSearchFallback(keyword, type);
                        if (fallbackResults.length > 0) {
                            results = fallbackResults;
                        }
                    }

                    if (!results.length) {
                        await session.send('未找到相关结果。(备用也没用，我劝你换个关键词试试)');
                        return;
                    }
                    
                    
                    // 单结果直接处理
                    if (results.length === 1) {
                        const item = results[0];
                        await ensureValidCookie();
                        
                        let img;
                        if (type === 'author') img = await drawAuthorCard(item.link);
                        else if (type === 'user') {
                            const uid = item.link.match(/\/(\d+)(?:\.html|\/)?$/)?.[1] || '0';
                            img = await drawCenterCardImpl(uid, logger);
                        }
                        else if (type === 'mod' || type === 'pack') img = await drawModCard(item.link);
                        else if (type === 'tutorial') img = await drawTutorialCard(item.link);
                        else img = await createInfoCard(item.link, type);
                        
                        await session.send(h.image(img, 'image/png'));
                        if (config.sendLink) await session.send(`链接: ${item.link}`);
                        return;
                    }
                    
                    // 多结果：初始化状态（隔离在 session.cid）
                    clearState(session.cid);
                    const listText = formatListPage(results, 0, type);
                    const sentMessageIds = await session.send(listText);
                    
                    searchStates.set(session.cid, { 
                        type, 
                        results, 
                        pageIndex: 0, 
                        messageIds: sentMessageIds,
                        timer: setTimeout(() => searchStates.delete(session.cid), TIMEOUT_MS) 
                    });
                 } catch (e) {
                    logger.error(e);
                    await session.send(`处理失败: ${e.message}`);
                 }
             });
         });
  });

  ctx.command(`${prefix} <keyword:text>`)
     .action(async ({ session }, keyword) => {
       if (!keyword) return '请输入关键词。';

       enqueue(session, 'search-mod', async () => {
         try {
            if (config.debug) logger.debug(`[${session.userId}] 正在搜索 ${keyword} ...`);

            let results = await fetchSearch(keyword, 'mod');
            if (!results.length && FALLBACK_TYPE_MAP.mod) {
                if (config.debug) logger.debug('主搜索为空，尝试备用接口: mod');
                const fallbackResults = await fetchSearchFallback(keyword, 'mod');
                if (fallbackResults.length > 0) {
                    results = fallbackResults;
                }
            }

            if (!results.length) {
                await session.send('未找到相关结果。(备用也没用，我劝你换个关键词试试)');
                return;
            }

            if (results.length === 1) {
                const item = results[0];
                await ensureValidCookie();

                const img = await drawModCard(item.link);
                await session.send(h.image(img, 'image/png'));
                if (config.sendLink) await session.send(`链接: ${item.link}`);
                return;
            }

            clearState(session.cid);
            const listText = formatListPage(results, 0, 'mod');
            const sentMessageIds = await session.send(listText);

            searchStates.set(session.cid, {
                results,
                page: 0,
                type: 'mod',
                messageIds: Array.isArray(sentMessageIds) ? sentMessageIds : [sentMessageIds],
                timer: setTimeout(() => {
                    tryWithdraw(session, Array.isArray(sentMessageIds) ? sentMessageIds : [sentMessageIds]);
                    clearState(session.cid);
                }, config.timeouts || 60000),
            });
         } catch (e) {
            logger.error('执行出错:', e);
            await session.send(`执行出错: ${e.message}`);
         }
       });
     });

  // --- 中间件 (处理序号选择) ---
  ctx.middleware(async (session, next) => {
    // 1. 专一性检查：只处理当前有搜索状态的用户
    const state = searchStates.get(session.cid);
    if (!state) return next();

    const input = session.content.trim().toLowerCase();
    
    // 退出
    if (input === 'q' || input === '退出') {
        clearState(session.cid);
        await tryWithdraw(session, state.messageIds); // 退出时也可以顺手撤回列表
        await session.send('已退出搜索。');
        return;
    }
    
    // 翻页
    if (input === 'p' || input === 'n') {
        // 加入队列处理翻页，防止并发
        enqueue(session, 'page-turn', async () => {
            // 重新获取状态，防止排队期间状态丢失
            const currentState = searchStates.get(session.cid);
            if (!currentState) return;

            clearTimeout(currentState.timer);
            currentState.timer = setTimeout(() => searchStates.delete(session.cid), TIMEOUT_MS);
            
            const total = Math.ceil(currentState.results.length / PAGE_SIZE);
            let newIndex = currentState.pageIndex;
            
            if (input === 'n' && currentState.pageIndex < total - 1) newIndex++;
            else if (input === 'p' && currentState.pageIndex > 0) newIndex--;
            else {
                await session.send('没有更多页面了。');
                return;
            }

            // 撤回旧列表（可选，为了整洁）
            await tryWithdraw(session, currentState.messageIds);

            currentState.pageIndex = newIndex;
            const newMsgIds = await session.send(formatListPage(currentState.results, currentState.pageIndex, currentState.type));
            currentState.messageIds = newMsgIds;
        });
        return;
    }
    
    // 选择序号
    const choice = parseInt(input);
    if (!isNaN(choice) && choice >= 1) {
        // 加入队列处理生成卡片
        enqueue(session, 'select-item', async () => {
            const currentState = searchStates.get(session.cid);
            if (!currentState) return; // 状态可能已过期

            const idx = choice - 1;
            const pageStart = currentState.pageIndex * PAGE_SIZE;
            const pageEnd = Math.min(pageStart + PAGE_SIZE, currentState.results.length);
            
            if (choice < pageStart + 1 || choice > pageEnd) {
                // 如果序号不在当前页，忽略或提示
                // await session.send(`请输入当前页显示的序号 (${pageStart + 1}-${pageEnd})。`);
                return; 
            }
            
            if (idx >= 0 && idx < currentState.results.length) {
                const item = currentState.results[idx];
                
                // 撤回列表消息
                await tryWithdraw(session, currentState.messageIds);
                clearState(session.cid); // 完成交互，清除状态

                try {
                    await ensureValidCookie();
                    let img;
                    
                    if (currentState.type === 'author') img = await drawAuthorCard(item.link);
                    else if (currentState.type === 'user') {
                        const uid = item.link.match(/\/(\d+)(?:\.html|\/)?$/)?.[1] || '0';
                        img = await drawCenterCardImpl(uid, logger);
                    }
                    else if (currentState.type === 'mod' || currentState.type === 'pack') img = await drawModCard(item.link);
                    else if (currentState.type === 'tutorial') img = await drawTutorialCard(item.link);
                    else img = await createInfoCard(item.link, currentState.type);
                    
                    await session.send(h.image(img, 'image/png'));
                    if (config.sendLink) await session.send(`链接: ${item.link}`);
                } catch (e) {
                    logger.error(e);
                    await session.send(`生成失败: ${e.message}`);
                }
            }
        });
        return;
    }
    
    return next();
  });
}
