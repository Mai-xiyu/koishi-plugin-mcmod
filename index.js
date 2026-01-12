const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, registerFont, GlobalFonts } = require('@napi-rs/canvas');
const { h, Schema } = require('koishi');

// Cookie 管理器
let cookieManager = null;
try {
    cookieManager = require('./cookie-manager');
} catch (e) {
    // cookie-manager 不存在时静默忽略
}

// ================= 状态管理和常量 =================
const searchStates = new Map();
const PAGE_SIZE = 10;
const TIMEOUT_MS = 60000; 
const BASE_URL = 'https://mcmod.cn';
const CENTER_URL = 'https://center.mcmod.cn';

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
  
  const res = await fetchWithTimeout(searchUrl, { headers: getHeaders('https://search.mcmod.cn/') });
  const html = await res.text();
  const $ = cheerio.load(html);
  
  const results = [];
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
  return results;
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

// ================= 渲染：模组/整合包卡片 (修复数据抓取) =================
async function drawModCard(url) {
    const res = await fetchWithTimeout(url, { headers: getHeaders() });
    const html = await res.text();
    const $ = cheerio.load(html);

    // 1. 头部信息
    const titleHtml = $('.class-title').html() || '';
    // 完全移除 official-group 的内容后再处理标题
    const cleanTitleStr = titleHtml
        .replace(/<div class="class-official-group"[\s\S]*?<\/div>/gi, '')
        .replace(/<[^>]+>/g, '\n');
    const titleLines = cleanTitleStr.split('\n').map(s=>s.trim()).filter(s=>s);
    const title = titleLines[0] || cleanText($('.class-title').text().replace(/开源|活跃|稳定|闭源|停更|弃坑|半弃坑|Beta/g, '').trim());
    const subTitle = titleLines.slice(1).join(' ');

    let coverUrl = fixUrl($('.class-cover-image img').attr('src'));
    let iconUrl = fixUrl($('.class-icon img').attr('src'));
    if (!coverUrl) coverUrl = iconUrl;

    // 标签 - 只从 official-group 获取状态标签
    const tags = [];
    const officialTags = new Set(); // 用于记录官方标签，避免重复
    
    $('.class-official-group div').each((i, el) => {
        const txt = cleanText($(el).text());
        if (!txt || txt.length > 20) return; // 跳过空或过长的内容
        
        officialTags.add(txt); // 记录官方标签
        
        let color = '#999';
        if (txt.includes('开源') || txt.includes('活跃') || txt.includes('稳定')) color = '#2ecc71'; 
        else if (txt.includes('半弃坑') || txt.includes('Beta')) color = '#f39c12'; 
        else if (txt.includes('停更') || txt.includes('闭源') || txt.includes('弃坑')) color = '#e74c3c'; 
        tags.push({ t: txt, bg: color, c: '#fff' });
    });
    
    // 模组分类标签（排除已有的官方标签）
    $('.class-label-list a').each((i, el) => {
        const labelText = cleanText($(el).text());
        if (!labelText || officialTags.has(labelText)) return; // 跳过重复
        
        const cls = $(el).attr('class') || '';
        let bg = '#e3f2fd', c = '#3498db';
        if(cls.includes('c_1')) { bg='#e8f5e9'; c='#2ecc71'; } 
        else if(cls.includes('c_3')) { bg='#fff3e0'; c='#e67e22'; }
        tags.push({ t: labelText, bg, c });
    });

    // 2. 统计数据 (针对0数据修复)
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

    // 修复：根据实际 HTML 结构获取推荐/收藏/关注数据
    // HTML: <div class="col-lg-12 common-fuc-group"><ul><li class="push"><div title="42" class="nums">42</div></li>...</ul></div>
    function getSocialNum(className) {
        let result = '0';
        
        // 遍历所有可能的选择器
        const selectors = [
            `.common-fuc-group li.${className} div.nums`,
            `.common-fuc-group li.${className} .nums`,
            `li.${className} div.nums`,
            `li.${className} .nums`,
        ];
        
        for (const sel of selectors) {
            const el = $(sel);
            if (el.length > 0) {
                // 优先从 title 属性获取
                const titleAttr = el.attr('title');
                if (titleAttr) {
                    const num = titleAttr.replace(/,/g, '').trim();
                    if (num && /^\d+$/.test(num)) {
                        result = num;
                        break;
                    }
                }
                // 其次从文本获取
                const text = el.text().replace(/,/g, '').trim();
                if (text && /^\d+$/.test(text)) {
                    result = text;
                    break;
                }
            }
        }
        
        return result;
    }

    const pushNum = getSocialNum('push');
    const favNum = getSocialNum('like');
    const subNum = getSocialNum('subscribe');
    
    const socialStats = [ { l:'推荐', v:pushNum }, { l:'收藏', v:favNum }, { l:'关注', v:subNum } ];

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

    const honors = [];
    $('.class-honor-list li').each((i, el) => { honors.push(cleanText($(el).text())); });

    // 版本 (修复：遍历嵌套 ul)
    const versions = [];
    // 查找 .mcver 下的所有直接子 ul，或者嵌套的 ul
    const mcVerRoot = $('.mcver');
    
    // 策略：mcmod 通常结构是 ul > ul > li
    let verGroups = mcVerRoot.find('ul ul'); 
    if (verGroups.length === 0) {
        // 备用：也许是直接 ul > li
        verGroups = mcVerRoot.find('ul').first();
    }

    // 遍历找到的 ul 组
    // 如果是多加载器，通常是多个 ul
    const allUls = mcVerRoot.find('ul');
    
    allUls.each((i, ul) => {
        // 排除作为容器的 ul (如果有子 ul)
        if ($(ul).find('ul').length > 0) return;

        let loader = '';
        const listItems = $(ul).find('li');
        const vers = [];

        listItems.each((j, li) => {
            const txt = cleanText($(li).text());
            // 如果是以冒号结尾，认为是标题 (例如 "Forge:")
            if (txt.includes(':') || txt.includes('：')) {
                loader = txt.replace(/[:：]/g, '').trim();
            } else {
                vers.push(txt);
            }
        });

        // 如果没有显式 Loader 标题，尝试从前一个兄弟元素找
        if (!loader) {
             // 有时候标题是 ul 前面的文本
             // 这里简单处理：如果没找到 loader，默认为 "通用" 或 "其他"
             // 但根据提供的 HTML，第一个 li 就是 Forge: 
        }
        
        if (loader && vers.length > 0) {
            versions.push({ l: loader, v: vers.join(', ') });
        }
    });


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

    const descRoot = $('.common-text').first();
    const descNodes = [];
    function parseNode(node, depth = 0) {
        if (depth > 10) return; // 防止过深递归
        
        if (node.type === 'text') {
            const t = cleanText(node.data);
            if (t && t.length > 1) {
                // 避免重复添加相同文本
                const lastNode = descNodes[descNodes.length - 1];
                if (!lastNode || lastNode.type !== 't' || lastNode.val !== t) {
                    descNodes.push({ type: 't', val: t, tag: 'p' });
                }
            }
        } else if (node.type === 'tag') {
            const tagName = node.name;
            if (tagName === 'img') {
                const src = node.attribs['data-src'] || node.attribs['src'];
                if (src && !src.includes('icon') && !src.includes('smilies') && !src.includes('loading')) {
                    descNodes.push({ type: 'i', src: fixUrl(src) });
                }
            } else if (['h1','h2','h3','h4','h5','h6'].includes(tagName)) {
                const text = cleanText($(node).text());
                if (text && text.length > 1) {
                    descNodes.push({ type: 't', val: text, tag: 'h' });
                }
            } else if (tagName === 'li') {
                const text = cleanText($(node).text());
                if (text && text.length > 1) {
                    descNodes.push({ type: 't', val: '• ' + text, tag: 'li' });
                }
            } else if (tagName === 'p') {
                // 对于 p 标签，先收集内部文本再递归处理子节点
                const pText = $(node).clone().children().remove().end().text().trim();
                if (pText) descNodes.push({ type: 't', val: pText, tag: 'p' });
                if (node.children) node.children.forEach(child => parseNode(child, depth + 1));
            } else if (tagName === 'br') {
                descNodes.push({ type: 'br' });
            } else if (['div', 'span', 'section', 'article'].includes(tagName)) {
                if (node.children) node.children.forEach(child => parseNode(child, depth + 1));
            } else if (tagName === 'ul' || tagName === 'ol') {
                // 列表特殊处理
                if (node.children) node.children.forEach(child => parseNode(child, depth + 1));
            } else if (tagName === 'strong' || tagName === 'b' || tagName === 'em' || tagName === 'i') {
                // 强调文本直接提取
                const text = cleanText($(node).text());
                if (text && text.length > 1) {
                    descNodes.push({ type: 't', val: text, tag: 'p' });
                }
            } else {
                if (node.children) node.children.forEach(child => parseNode(child, depth + 1));
            }
        }
    }
    
    if (descRoot.length) {
        descRoot[0].children.forEach(child => parseNode(child, 0));
    }
    
    // 如果没有提取到内容，使用 meta 描述
    if (descNodes.length === 0) {
        const metaDesc = $('meta[name="description"]').attr('content');
        if (metaDesc) descNodes.push({ type: 't', val: metaDesc, tag: 'p' });
    }
    
    // 去重和清理
    const cleanedNodes = [];
    let lastText = '';
    for (const node of descNodes) {
        if (node.type === 't') {
            // 避免连续重复的文本
            if (node.val !== lastText) {
                cleanedNodes.push(node);
                lastText = node.val;
            }
        } else {
            cleanedNodes.push(node);
            lastText = '';
        }
    }
    descNodes.length = 0;
    descNodes.push(...cleanedNodes);

    const width = 800;
    const font = GLOBAL_FONT_FAMILY;
    const pad = 30;
    
    // 头部高度计算
    const dummyC = createCanvas(100, 100);
    const dummy = dummyC.getContext('2d');
    
    let headCalcY = 40;
    if(tags.length > 0) headCalcY += 35;
    dummy.font = `bold 40px "${font}"`;
    const titleW = width * 0.65; 
    const calcTitleH = wrapText(dummy, title, 0, 0, titleW, 50, 100, false);
    headCalcY += calcTitleH;
    if(subTitle) headCalcY += 30;
    if(authors.length > 0) {
        headCalcY += 30; 
        let ax = pad;
        let totalAuthH = 60;
        for(const a of authors) {
            dummy.font = `bold 18px "${font}"`; const nW = dummy.measureText(a.n).width;
            dummy.font = `12px "${font}"`; const rW = dummy.measureText(a.r||'作者').width;
            const itemW = 60 + nW + Math.max(rW, 20) + 30; 
            if(ax + itemW > titleW) { ax = pad; totalAuthH += 60; }
            ax += itemW;
        }
        headCalcY += totalAuthH;
    }
    const bannerH = Math.max(320, headCalcY + 40);

    const canvas = createCanvas(width, 15000);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f0f2f5'; ctx.fillRect(0,0,width,15000);

    try {
        if(coverUrl) {
            const img = await loadImage(coverUrl);
            const r = Math.max(width/img.width, bannerH/img.height);
            // 使用 Clip 确保不溢出
            ctx.save();
            ctx.beginPath(); ctx.rect(0,0,width,bannerH); ctx.clip();
            ctx.drawImage(img, 0,0,img.width,img.height, (width-img.width*r)/2, (bannerH-img.height*r)/2, img.width*r, img.height*r);
            ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(0,0,width,bannerH);
            ctx.restore();
        } else {
            ctx.fillStyle = '#2c3e50'; ctx.fillRect(0,0,width,bannerH);
        }
    } catch(e) { ctx.fillStyle='#333'; ctx.fillRect(0,0,width,bannerH); }

    let headY = 40;
    let tx = pad;
    tags.forEach(t => {
        ctx.font = `bold 14px "${font}"`; const w = ctx.measureText(t.t).width + 16;
        ctx.fillStyle = t.bg; roundRect(ctx, tx, headY, w, 26, 4); ctx.fill();
        ctx.fillStyle = t.c; ctx.fillText(t.t, tx+8, headY+18); tx += w + 10;
    });
    if(tags.length) headY += 45;

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#fff'; ctx.font = `bold 40px "${font}"`;
    headY = wrapText(ctx, title, pad, headY, width*0.65, 50, 5, true) + 10;
    if(subTitle) {
        ctx.fillStyle = '#ccc'; ctx.font = `18px "${font}"`;
        ctx.fillText(subTitle, pad, headY);
        headY += 35;
    } else { headY += 15; }

    if(authors.length > 0) {
        let ax = pad;
        for(const a of authors) {
            ctx.font = `bold 18px "${font}"`; const nW = ctx.measureText(a.n).width;
            ctx.font = `12px "${font}"`; const rW = ctx.measureText(a.r||'作者').width;
            const itemW = 60 + nW + Math.max(rW, 20) + 30;
            if(ax + itemW > width*0.65) { ax = pad; headY += 60; }
            ctx.save(); ctx.beginPath(); ctx.arc(ax+24, headY+24, 24, 0, Math.PI*2); 
            ctx.fillStyle='#eee'; ctx.fill(); ctx.clip();
            if(a.i) { try{ const img=await loadImage(a.i); ctx.drawImage(img, ax, headY, 48, 48); }catch(e){} }
            ctx.restore();
            ctx.fillStyle='#fff'; ctx.font=`bold 18px "${font}"`; ctx.fillText(a.n, ax+60, headY+5);
            ctx.fillStyle='#999'; ctx.font=`12px "${font}"`; ctx.fillText(a.r||'作者', ax+60, headY+28);
            ax += itemW;
        }
    }

    let rx = width - 40, ry = 40;
    const sbW = 140, sbH = 90;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth=2;
    roundRect(ctx, rx-sbW, ry, sbW, sbH, 10); ctx.stroke();
    ctx.textAlign='center';
    ctx.fillStyle='#fff'; ctx.font=`bold 42px "${font}"`; ctx.fillText(score, rx-sbW/2, ry+12);
    ctx.font=`16px "${font}"`; ctx.fillText(scoreComment||'综合评分', rx-sbW/2, ry+62);
    ctx.textAlign='left';
    
    ry += 110;
    const drawHeaderStat = (l, v) => {
        ctx.textAlign='right';
        ctx.fillStyle='#aaa'; ctx.font=`14px "${font}"`; ctx.fillText(l, rx, ry);
        ctx.fillStyle='#fff'; ctx.font=`bold 20px "${font}"`; ctx.fillText(v, rx - ctx.measureText(l).width - 15, ry-3);
        ctx.textAlign='left'; ry += 35;
    };
    drawHeaderStat('总浏览', viewNum);
    if(fillRate!=='--') drawHeaderStat('填充率', fillRate);
    socialStats.forEach(s => drawHeaderStat(s.l, s.v));
    if(yIndex) drawHeaderStat('昨日指数', yIndex);

    let cursorY = bannerH + 20;

    const propStart = cursorY;
    ctx.fillStyle = '#fff';
    let py = propStart + 30;
    const pColW = (width - 80) / 2;

    props.forEach((p, i) => {
        const col = i % 2; const row = Math.floor(i / 2);
        const px = 40 + col * pColW; const pposy = py + row * 35;
        ctx.fillStyle = '#888'; ctx.font = `14px "${font}"`; ctx.fillText(p.l+':', px, pposy);
        const lw = ctx.measureText(p.l+':').width;
        ctx.fillStyle = '#333'; ctx.font = `14px "${font}"`; ctx.fillText(p.v, px+lw+5, pposy);
    });
    py += Math.ceil(props.length/2)*35 + 15;

    if(versions.length) {
        py += 10;
        ctx.fillStyle='#333'; ctx.font=`bold 18px "${font}"`; ctx.fillText('支持版本', 40, py); py+=30;
        versions.forEach(v => {
            ctx.fillStyle='#555'; ctx.font=`bold 14px "${font}"`; ctx.fillText(v.l, 40, py);
            const lw = ctx.measureText(v.l).width + 10;
            ctx.fillStyle='#e74c3c'; ctx.font=`14px "${font}"`; 
            py = wrapText(ctx, v.v, 40+lw, py, width-80-lw, 24, 500, true) + 15;
        });
    }

    if(links.length) {
        py += 20; let lx = 40;
        links.forEach(l => {
            ctx.font = `bold 14px "${font}"`; const w = ctx.measureText(l).width+30;
            if(lx+w < width-40) {
                ctx.fillStyle = '#333'; roundRect(ctx, lx, py, w, 30, 6); ctx.fill();
                ctx.fillStyle = '#fff'; ctx.fillText(l, lx+15, py+8);
                lx += w + 10;
            }
        });
        py += 50;
    }

    const propH = py - propStart + 10;
    ctx.globalCompositeOperation='destination-over';
    ctx.fillStyle='#fff'; roundRect(ctx, 20, propStart, width-40, propH, 12); ctx.fill();
    ctx.globalCompositeOperation='source-over';
    
    cursorY += propH + 20;

    const descStart = cursorY;
    ctx.fillStyle='#333'; ctx.font=`bold 22px "${font}"`; ctx.fillText('简介', 40, descStart+30);
    ctx.strokeStyle='#3498db'; ctx.lineWidth=4; ctx.beginPath(); ctx.moveTo(40, descStart+45); ctx.lineTo(80, descStart+45); ctx.stroke();

    let dy = descStart + 70;
    for (const node of descNodes) {
        if (node.type === 't') {
            if (node.tag === 'h') { ctx.fillStyle='#2c3e50'; ctx.font=`bold 20px "${font}"`; dy+=20; }
            else if (node.tag === 'li') { ctx.fillStyle='#555'; ctx.font=`16px "${font}"`; }
            else { ctx.fillStyle='#444'; ctx.font=`16px "${font}"`; }
            
            if(node.val.trim()) {
                dy = wrapText(ctx, node.val, 40, dy, width-80, 28, 5000, true) + 15;
            }
        } else if (node.type === 'i') {
            dy += 15;
            try {
                const img = await loadImage(node.src);
                const maxW = width - 80;
                const r = Math.min(1, maxW/img.width);
                const dw = img.width * r; const dh = img.height * r;
                ctx.drawImage(img, 40+(maxW-dw)/2, dy, dw, dh);
                dy += dh + 25;
            } catch(e) {}
        } else if (node.type === 'br') { dy += 10; }
    }

    const descH = dy - descStart + 40;
    ctx.globalCompositeOperation='destination-over';
    ctx.fillStyle='#fff'; roundRect(ctx, 20, descStart, width-40, descH, 12); ctx.fill();
    ctx.globalCompositeOperation='source-over';

    cursorY += descH + 40;
    ctx.fillStyle='#ccc'; ctx.font=`12px "${font}"`; ctx.textAlign='center';
    ctx.fillText('mcmod.cn | Powered by Koishi', width/2, cursorY-15);

    const finalCanvas = createCanvas(width, cursorY);
    finalCanvas.getContext('2d').drawImage(canvas, 0,0,width,cursorY, 0,0,width,cursorY);
    return finalCanvas.toBuffer('image/png');
}

async function drawTutorialCard(url) {
    const res = await fetchWithTimeout(url, { headers: getHeaders() });
    const html = await res.text();
    const $ = cheerio.load(html);

    // 提取教程基本信息
    const title = cleanText($('h1, .post-title, .article-title').first().text()) || cleanText($('title').text().split('-')[0]);
    
    // 作者信息 (从 post-user-frame 获取)
    let author = cleanText($('.post-user-frame .post-user-name a').first().text());
    if (!author) author = cleanText($('.post-user-name a').first().text());
    if (!author) author = cleanText($('a[href*="/center/"]').first().text());
    if (!author) author = '未知作者';
    
    // 作者头像
    let authorAvatar = fixUrl($('.post-user-frame .post-user-avatar img').attr('src'));
    if (!authorAvatar) authorAvatar = fixUrl($('.post-user-avatar img').attr('src'));

    // 从 common-rowlist-2 获取详细信息
    let views = '0';
    let date = '';
    $('.common-rowlist-2 li').each((i, el) => {
        const text = $(el).text();
        if (text.includes('浏览量')) {
            views = text.replace(/[^0-9]/g, '') || '0';
        }
        if (text.includes('创建日期')) {
            // 优先从 data-original-title 获取完整日期
            const fullDate = $(el).attr('data-original-title');
            if (fullDate) {
                date = fullDate.split(' ')[0]; // 只取日期部分
            } else {
                date = text.replace('创建日期：', '').trim();
            }
        }
    });
    
    // 获取推荐和收藏 (需要 Cookie 登录状态)
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
                // 优先从 title 属性获取
                const titleAttr = el.attr('title');
                if (titleAttr) {
                    const num = titleAttr.replace(/,/g, '').trim();
                    if (num && /^\d+$/.test(num)) {
                        result = num;
                        break;
                    }
                }
                // 其次从文本获取
                const text = el.text().replace(/,/g, '').trim();
                if (text && /^\d+$/.test(text)) {
                    result = text;
                    break;
                }
            }
        }
        return result;
    }
    const pushNum = getSocialNum('push');
    const favNum = getSocialNum('like');

    // 提取目录
    const tocItems = [];
    $('a[href^="javascript:void(0);"]').each((i, el) => {
        const text = cleanText($(el).text());
        if (text && text.length > 2 && text.length < 50 && !text.includes('百科') && !text.includes('登录')) {
            tocItems.push(text);
        }
    });

    // 提取正文内容（段落和图片）
    const contentNodes = [];
    const contentRoot = $('.post-content, .article-content, .common-text').first();
    
    function parseContent(node) {
        if (node.type === 'text') {
            const t = cleanText(node.data);
            if (t && t.length > 1) contentNodes.push({ type: 't', val: t, tag: 'p' });
        } else if (node.type === 'tag') {
            const tagName = node.name;
            if (tagName === 'img') {
                const src = node.attribs['data-src'] || node.attribs['src'];
                if (src && !src.includes('loading') && !src.includes('smilies')) {
                    contentNodes.push({ type: 'i', src: fixUrl(src) });
                }
            } else if (['h1','h2','h3','h4'].includes(tagName)) {
                const text = cleanText($(node).text());
                if (text) contentNodes.push({ type: 't', val: text, tag: 'h' });
            } else if (tagName === 'li') {
                const text = cleanText($(node).text());
                if (text) contentNodes.push({ type: 't', val: '• ' + text, tag: 'li' });
            } else if (['p', 'div', 'blockquote', 'span', 'strong', 'b'].includes(tagName)) {
                if (node.children) node.children.forEach(parseContent);
            } else {
                if (node.children) node.children.forEach(parseContent);
            }
        }
    }
    
    if (contentRoot.length) contentRoot[0].children.forEach(parseContent);
    
    // 如果没有提取到内容，使用 meta 描述
    if (contentNodes.length === 0) {
        const metaDesc = $('meta[name="description"]').attr('content');
        if (metaDesc) contentNodes.push({ type: 't', val: metaDesc, tag: 'p' });
    }

    const width = 800;
    const font = GLOBAL_FONT_FAMILY;
    const padding = 30;
    
    // 预计算高度
    const tempCanvas = createCanvas(100, 100);
    const tempCtx = tempCanvas.getContext('2d');
    let estimatedHeight = 250; // Header area
    
    // TOC 高度
    if (tocItems.length > 0) {
        estimatedHeight += 70 + Math.ceil(tocItems.length / 2) * 30;
    }
    
    // 内容高度估算 (遍历所有节点)
    tempCtx.font = `16px "${font}"`;
    for (const node of contentNodes) { 
        if (node.type === 't') {
            const isHeader = node.tag === 'h';
            const fontSize = isHeader ? 22 : 16;
            tempCtx.font = `${isHeader ? 'bold' : ''} ${fontSize}px "${font}"`;
            const lineHeight = Math.floor(fontSize * 1.6);
            const lines = wrapText(tempCtx, node.val, 0, 0, width - padding*2 - 40, lineHeight, 10000, false) / lineHeight;
            estimatedHeight += lines * lineHeight + (isHeader ? 25 : 15);
        } else if (node.type === 'i') {
            estimatedHeight += 500; // 预估图片高度
        }
    }
    
    estimatedHeight = Math.min(estimatedHeight + 300, 30000); // 增加最大高度限制

    const canvas = createCanvas(width, estimatedHeight);
    const ctx = canvas.getContext('2d');
    
    // 背景
    ctx.fillStyle = '#f0f2f5';
    ctx.fillRect(0, 0, width, estimatedHeight);

    // 顶部装饰条
    const headerH = 180;
    const grad = ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, '#4facfe');
    grad.addColorStop(1, '#00f2fe');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, headerH);
    
    // 装饰圆圈
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath(); ctx.arc(width-100, 50, 80, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(100, 150, 60, 0, Math.PI*2); ctx.fill();

    // 主卡片容器
    const mainCardW = width - 40;
    let cursorY = 80; 
    
    // 1. 标题卡片
    ctx.shadowColor = 'rgba(0,0,0,0.1)';
    ctx.shadowBlur = 15;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = '#fff';
    
    // 标题文字计算
    ctx.font = `bold 32px "${font}"`;
    const titleLines = wrapText(ctx, title, 0, 0, mainCardW - 60, 45, 3, false) / 45;
    const actualTitleH = 60 + titleLines * 45 + 80; // 增加高度放作者信息
    
    roundRect(ctx, 20, cursorY, mainCardW, actualTitleH, 16);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    
    // 绘制标题内容
    ctx.fillStyle = '#333';
    ctx.textBaseline = 'top';
    wrapText(ctx, title, 50, cursorY + 30, mainCardW - 60, 45, 3, true);
    
    // 作者信息区域（带头像）
    const authorY = cursorY + 30 + titleLines * 45 + 15;
    const avatarSize = 36;
    
    // 绘制作者头像
    if (authorAvatar) {
        try {
            const avImg = await loadImage(authorAvatar);
            ctx.save();
            ctx.beginPath();
            ctx.arc(50 + avatarSize/2, authorY + avatarSize/2, avatarSize/2, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(avImg, 50, authorY, avatarSize, avatarSize);
            ctx.restore();
        } catch (e) {
            // 绘制默认头像占位
            ctx.fillStyle = '#e0e0e0';
            ctx.beginPath();
            ctx.arc(50 + avatarSize/2, authorY + avatarSize/2, avatarSize/2, 0, Math.PI * 2);
            ctx.fill();
        }
    } else {
        // 默认头像
        ctx.fillStyle = '#e0e0e0';
        ctx.beginPath();
        ctx.arc(50 + avatarSize/2, authorY + avatarSize/2, avatarSize/2, 0, Math.PI * 2);
        ctx.fill();
    }
    
    // 作者名称
    ctx.fillStyle = '#3498db';
    ctx.font = `bold 16px "${font}"`;
    ctx.fillText(author, 50 + avatarSize + 12, authorY + 5);
    
    // 日期
    ctx.fillStyle = '#999';
    ctx.font = `12px "${font}"`;
    ctx.fillText(date || '未知日期', 50 + avatarSize + 12, authorY + 24);
    
    // 右侧统计数据
    ctx.textAlign = 'right';
    const statsX = mainCardW;
    ctx.font = `14px "${font}"`;
    
    // 浏览量
    ctx.fillStyle = '#666';
    ctx.fillText(`浏览 ${views}`, statsX, authorY + 5);
    
    // 推荐和收藏
    ctx.fillStyle = '#e74c3c';
    ctx.fillText(`推荐 ${pushNum}`, statsX - 100, authorY + 5);
    ctx.fillStyle = '#f39c12';
    ctx.fillText(`收藏 ${favNum}`, statsX - 200, authorY + 5);
    
    ctx.textAlign = 'left';
    
    cursorY += actualTitleH + 20;

    // 2. 目录卡片
    if (tocItems.length > 0) {
        const tocH = 60 + Math.ceil(tocItems.length / 2) * 30;
        
        ctx.shadowColor = 'rgba(0,0,0,0.05)';
        ctx.shadowBlur = 10;
        ctx.fillStyle = '#fff';
        roundRect(ctx, 20, cursorY, mainCardW, tocH, 16);
        ctx.fill();
        ctx.shadowBlur = 0;
        
        ctx.fillStyle = '#3498db';
        ctx.fillRect(20, cursorY + 20, 4, 24);
        
        ctx.fillStyle = '#333';
        ctx.font = `bold 18px "${font}"`;
        ctx.fillText('目录导航', 35, cursorY + 22);
        
        ctx.fillStyle = '#555';
        ctx.font = `14px "${font}"`;
        const colW = (mainCardW - 60) / 2;
        tocItems.forEach((item, i) => {
            const col = i % 2;
            const row = Math.floor(i / 2);
            const x = 50 + col * colW;
            const y = cursorY + 60 + row * 30;
            ctx.fillText(`${i+1}. ${item.substring(0, 25)}${item.length>25?'...':''}`, x, y);
        });
        
        cursorY += tocH + 20;
    }

    // 3. 正文卡片
    const contentStart = cursorY;
    let contentDrawY = contentStart + 30;
    const contentLeft = 50;
    const contentW = mainCardW - 60;
    
    ctx.fillStyle = '#333';
    
    // 遍历所有节点
    for (const node of contentNodes) {
        if (contentDrawY > estimatedHeight - 50) break; // 防止溢出
        
        if (node.type === 't') {
            const isHeader = node.tag === 'h';
            const fontSize = isHeader ? 22 : 16;
            const lineHeight = Math.floor(fontSize * 1.6);
            
            ctx.font = `${isHeader ? 'bold' : ''} ${fontSize}px "${font}"`;
            ctx.fillStyle = isHeader ? '#2c3e50' : '#444';
            
            if (isHeader) {
                contentDrawY += 15;
                ctx.fillStyle = '#3498db'; 
                ctx.fillRect(contentLeft - 15, contentDrawY + 5, 4, 20);
                ctx.fillStyle = '#2c3e50';
            }
            
            contentDrawY = wrapText(ctx, node.val, contentLeft, contentDrawY, contentW, lineHeight, 100, true) + (isHeader ? 15 : 10);
            
        } else if (node.type === 'i') {
            contentDrawY += 15;
            try {
                const img = await loadImage(node.src);
                const maxW = contentW;
                const maxH = 800; // 允许更高的图片
                let dw = img.width;
                let dh = img.height;
                
                if (dw > maxW) {
                    const ratio = maxW / dw;
                    dw = maxW;
                    dh = dh * ratio;
                }
                if (dh > maxH) {
                    const ratio = maxH / dh;
                    dh = maxH;
                    dw = dw * ratio;
                }
                
                ctx.save();
                ctx.shadowColor = 'rgba(0,0,0,0.1)';
                ctx.shadowBlur = 8;
                const dx = contentLeft + (contentW - dw) / 2;
                ctx.drawImage(img, dx, contentDrawY, dw, dh);
                ctx.restore();
                
                contentDrawY += dh + 25;
            } catch (e) {}
        }
    }
    
    const contentEnd = contentDrawY + 30;
    const contentHeight = contentEnd - contentStart;
    
    // 绘制正文卡片背景
    ctx.globalCompositeOperation = 'destination-over';
    ctx.shadowColor = 'rgba(0,0,0,0.05)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#fff';
    roundRect(ctx, 20, contentStart, mainCardW, contentHeight, 16);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
    
    cursorY = contentEnd + 20;
    
    // 底部版权
    ctx.fillStyle = '#999';
    ctx.font = `12px "${font}"`;
    ctx.textAlign = 'center';
    ctx.fillText('教程来源: mcmod.cn | Powered by Koishi', width / 2, cursorY);
    
    const finalH = cursorY + 30;
    const finalCanvas = createCanvas(width, finalH);
    finalCanvas.getContext('2d').drawImage(canvas, 0, 0, width, finalH, 0, 0, width, finalH);
    
    return finalCanvas.toBuffer('image/png');
}
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
    const pageInfo = {};
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
    const statsMap = {};
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

    const activityMap = {};
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
    let curr = new Date(currentYear, 0, 1);
    const end = new Date(currentYear, 11, 31);
    while(curr<=end) {
        const doy = Math.floor((curr - new Date(currentYear,0,1))/86400000);
        const c = Math.floor((doy + new Date(currentYear,0,1).getDay() + 6)/7);
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
async function createInfoCard(url, type) {
  const res = await fetchWithTimeout(url, { headers: getHeaders('https://search.mcmod.cn/') });
  const $ = cheerio.load(await res.text());
  const title = cleanText($('.item-title, .class-title, h1').first().text());
  const modName = cleanText($('.breadcrumb li').eq(1).text() || $('.class-relation-list a').first().text());
  let imgUrl = fixUrl($('.item-icon img, .mod-icon img').attr('src') || $('meta[property="og:image"]').attr('content'));
  let desc = cleanText($('.item-desc, .common-text').first().text() || $('meta[name="description"]').attr('content'));
  if (desc.length > 300) desc = desc.substring(0, 300) + '...';
  const width = 700, height = 350;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const font = GLOBAL_FONT_FAMILY;
  ctx.fillStyle = '#f9f9f9'; ctx.fillRect(0, 0, width, height);
  let textX = 30, textY = 30;
  let imgObj = null;
  if (imgUrl) { try { imgObj = await loadImage(imgUrl); } catch (e) {} }
  if (imgObj) {
      if (imgObj.width === imgObj.height || imgObj.width < 150) { ctx.drawImage(imgObj, 30, 30, 100, 100); textX = 150; } 
      else { ctx.drawImage(imgObj, 0, 0, width, 200); textY = 210; }
  }
  let titleY = (imgObj && textX === 150) ? 30 : textY;
  ctx.textBaseline = 'top'; ctx.fillStyle = '#000'; ctx.font = `bold 30px "${font}"`; ctx.fillText(title, textX, titleY);
  if (modName) { ctx.fillStyle = '#666'; ctx.font = `16px "${font}"`; ctx.fillText(`所属: ${modName}`, textX, titleY + 40); }
  let lineY = (imgObj && textX === 150) ? 140 : titleY + 50;
  ctx.strokeStyle = '#ddd'; ctx.beginPath(); ctx.moveTo(30, lineY); ctx.lineTo(width-30, lineY); ctx.stroke();
  ctx.fillStyle = '#333'; ctx.font = `18px "${font}"`; wrapText(ctx, desc || '暂无简介', 30, lineY + 20, width - 60, 28, 6);
  ctx.fillStyle = '#aaa'; ctx.font = `12px "${font}"`; ctx.fillText('数据来源: mcmod.cn', 30, height - 20);
  return canvas.toBuffer('image/png');
}

// ================= Koishi =================
module.exports.name = 'mcmod-search';
module.exports.Config = Schema.object({
  debug: Schema.boolean().default(false).description('开启调试日志'),
  sendLink: Schema.boolean().default(true).description('发送卡片后是否附带链接'),
  fontPath: Schema.string().role('path').description('【必填】中文字体路径'),
  cookie: Schema.string().description('【可选】手动填写 mcmod.cn 的 Cookie'),
  commands: Schema.object({
    mod: Schema.array(String).default(['搜索模组', '模组', 'mod']),
    data: Schema.array(String).default(['搜索资料', '资料', '查物品']),
    pack: Schema.array(String).default(['搜索整合包', '整合包']),
    tutorial: Schema.array(String).default(['搜索教程', '教程']),
    author: Schema.array(String).default(['搜索作者', '作者']),
    user: Schema.array(String).default(['搜索用户', '用户', '查用户']),
  }).description('指令触发词配置'),
});

module.exports.apply = function (ctx, config) {
  const logger = ctx.logger('mcmod');
  if (!initFont(config.fontPath, logger)) {}

  // 初始化 Cookie
  if (config.cookie) {
    globalCookie = config.cookie;
    logger.info('使用手动配置的 Cookie');
  } else if (config.autoCookie && cookieManager) {
    // 异步初始化自动 Cookie
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

  function clearState(cid) {
    const state = searchStates.get(cid);
    if (state && state.timer) clearTimeout(state.timer);
    searchStates.delete(cid);
  }

  for (const [type, aliases] of Object.entries(config.commands)) {
    const triggers = Array.isArray(aliases) ? aliases : [aliases];
    triggers.forEach(trigger => {
        ctx.command(`${trigger} <keyword:text>`)
           .action(async ({ session }, keyword) => {
             if (!keyword) return '请输入关键词。';
             try {
                if (config.debug) logger.debug('正在搜索 mcmod.cn ...');
                const results = await fetchSearch(keyword, type);
                if (!results.length) return '未找到相关结果。';
                
                // 如果只有1个结果，直接显示卡片
                if (results.length === 1) {
                    const item = results[0];
                    await ensureValidCookie();
                    try {
                        if (type === 'author') {
                            const img = await drawAuthorCard(item.link);
                            await session.send(h.image(img, 'image/png'));
                            if (config.sendLink) await session.send(`主页: ${item.link}`);
                        } else if (type === 'user') {
                            const uid = item.link.match(/\/(\d+)(?:\.html|\/)?$/)?.[1] || '0';
                            const img = await drawCenterCardImpl(uid, logger);
                            await session.send(h.image(img, 'image/png'));
                            if (config.sendLink) await session.send(`个人中心: ${CENTER_URL}/${uid}/`);
                        } else if (type === 'mod' || type === 'pack') {
                            const img = await drawModCard(item.link);
                            await session.send(h.image(img, 'image/png'));
                            if (config.sendLink) await session.send(`链接: ${item.link}`);
                        } else if (type === 'tutorial') {
                            const img = await drawTutorialCard(item.link);
                            await session.send(h.image(img, 'image/png'));
                            if (config.sendLink) await session.send(`链接: ${item.link}`);
                        } else {
                            const img = await createInfoCard(item.link, type);
                            await session.send(h.image(img, 'image/png'));
                            if (config.sendLink) await session.send(`链接: ${item.link}`);
                        }
                    } catch (e) {
                        logger.error(e); return `生成失败: ${e.message}`;
                    }
                    return;
                }
                
                clearState(session.cid);
                searchStates.set(session.cid, { type, results, pageIndex: 0, timer: setTimeout(() => searchStates.delete(session.cid), TIMEOUT_MS) });
                return formatListPage(results, 0, type);
             } catch (e) {
                logger.error(e); return `错误: ${e.message}`;
             }
           });
    });
  }

  ctx.middleware(async (session, next) => {
    const state = searchStates.get(session.cid);
    if (!state) return next();
    const input = session.content.trim().toLowerCase();
    if (input === 'q' || input === '退出') {
        clearState(session.cid);
        await session.send('已退出。');
        return;
    }
    if (input === 'p' || input === 'n') {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => searchStates.delete(session.cid), TIMEOUT_MS);
        const total = Math.ceil(state.results.length / PAGE_SIZE);
        if (input === 'n' && state.pageIndex < total - 1) state.pageIndex++;
        else if (input === 'p' && state.pageIndex > 0) state.pageIndex--;
        else {
            await session.send('没有更多页面了。');
            return;
        }
        await session.send(formatListPage(state.results, state.pageIndex, state.type));
        return;
    }
    const choice = parseInt(input);
    if (!isNaN(choice) && choice >= 1) {
        // 用户输入的是显示的序号（从1开始），直接转换为数组索引
        const idx = choice - 1;
        
        // 检查是否在当前页显示的范围内
        const pageStart = state.pageIndex * PAGE_SIZE;
        const pageEnd = Math.min(pageStart + PAGE_SIZE, state.results.length);
        
        if (choice < pageStart + 1 || choice > pageEnd) {
            // 输入的序号不在当前页范围内
            return session.send(`请输入当前页显示的序号 (${pageStart + 1}-${pageEnd})。`);
        }
        
        if (idx >= 0 && idx < state.results.length) {
            const item = state.results[idx];
            clearState(session.cid);
            try {
                // 确保 Cookie 有效（自动刷新）
                await ensureValidCookie();
                
                if (state.type === 'author') {
                    if (config.debug) logger.debug('正在生成作者名片...');
                    const img = await drawAuthorCard(item.link);
                    await session.send(h.image(img, 'image/png'));
                    if (config.sendLink) await session.send(`主页: ${item.link}`);
                } else if (state.type === 'user') {
                    if (config.debug) logger.debug('正在生成用户中心卡片...');
                    const uid = item.link.match(/\/(\d+)(?:\.html|\/)?$/)?.[1] || '0';
                    const img = await drawCenterCardImpl(uid, logger);
                    await session.send(h.image(img, 'image/png'));
                    if (config.sendLink) await session.send(`个人中心: ${CENTER_URL}/${uid}/`);
                } else if (state.type === 'mod' || state.type === 'pack') {
                    if (config.debug) logger.debug(`正在获取《${item.title}》...`);
                    const img = await drawModCard(item.link);
                    await session.send(h.image(img, 'image/png'));
                    if (config.sendLink) await session.send(`链接: ${item.link}`);
                } else if (state.type === 'tutorial') {
                    if (config.debug) logger.debug('正在获取教程...');
                    const img = await drawTutorialCard(item.link);
                    await session.send(h.image(img, 'image/png'));
                    if (config.sendLink) await session.send(`链接: ${item.link}`);
                } else {
                    const img = await createInfoCard(item.link, state.type);
                    await session.send(h.image(img, 'image/png'));
                    if (config.sendLink) await session.send(`链接: ${item.link}`);
                }
            } catch (e) {
                logger.error(e); return `生成失败: ${e.message}`;
            }
            return;
        }
    }
    return next();
  });
};
