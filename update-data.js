/**
 * 一键更新仪表盘数据脚本 (v4)
 *
 * v4: 使用 npm 全局 CLI（call-tool 格式），传递 startDate/endDate 获取全量运动记录（58条）
 * v3: 修复代理、bash 执行、变量命名等问题
 *
 * 用法：node update-data.js
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_DIR = __dirname;
const DASHBOARD = path.join(BASE_DIR, 'dashboard.html');
const MEMO      = path.join(BASE_DIR, 'memo.html');
const STUDY_LOG = path.join(BASE_DIR, '.study-log.json');

// ===== 配置 =====
const MAIMEMO_TOKEN  = 'f746779f407db84c743607e6b9fdf2c4d3b4cd9918333f924238e4313d353893';
const MAIMEMO_BASE  = 'https://open.maimemo.com/open/api/v1';
const COROS_CLI      = 'D:/soft/npm-global/node_modules/coros-mcp/dist/cli.js';

// ===== 执行命令（清除代理）=====
function run(cmd) {
  try {
    const env = Object.assign({}, process.env);
    ['http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY',
     'all_proxy','ALL_PROXY','no_proxy','NO_PROXY'].forEach(k => { delete env[k]; });
    env.NO_PROXY = '*';
    env.no_proxy = '*';
    env.http_proxy  = '';
    env.https_proxy = '';
    env.HTTP_PROXY  = '';
    env.HTTPS_PROXY = '';

    const opts = { encoding: 'utf-8', timeout: 30000, stdio: ['pipe','pipe','pipe'], env };
    return execSync(cmd, opts).trim();
  } catch (e) {
    return null;
  }
}

// ===== 调用 COROS MCP (npm CLI, call-tool 格式) =====
function corosCall(tool, args) {
  const argStr = (args !== undefined && args !== null)
    ? (typeof args === 'object' ? JSON.stringify(args) : String(args))
    : '{}';
  const cmd = 'node "' + COROS_CLI + '" call-tool --tool ' + tool + ' --arguments-json "' + argStr.replace(/"/g, '\\"') + '"';
  const raw = run(cmd);
  if (!raw || raw[0] !== '{') return '';
  try {
    const j = JSON.parse(raw);
    let text = (j && j.content && j.content[0] && j.content[0].text) || '';
    // 文本是 JSON 字符串（外层带引号、内层 \\n \\\" 转义）
    // JSON.parse 已解码一次，还需要手工处理剩余的转义
    text = text.replace(/^"|"$/g, '');              // 去掉外层引号
    text = text.replace(/\\n/g, '\n');               // \\n → 真实换行
    text = text.replace(/\\"/g, '"');                // \\" → 真实双引号
    return text;
  } catch (e) { return raw; }
}

// ===== 调用 MaiMemo API（curl --noproxy）=====
function maimemoCurl(endpoint, body) {
  const data = JSON.stringify(body || {});
  const url  = MAIMEMO_BASE + endpoint;
  const cmd = [
    'curl', '-s', '--noproxy', '*', '--max-time', '15',
    '-X', 'POST',
    url,
    '-H', '"Authorization: Bearer ' + MAIMEMO_TOKEN + '"',
    '-H', '"Content-Type: application/json"',
    '-d', '"' + data.replace(/"/g, '\\"') + '"',
  ].join(' ');
  const raw = run(cmd);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {
    console.log('  [curl] parse error, head:', raw.slice(0, 80));
    return null;
  }
}

// ■■■ 1. 拉取 COROS 数据 ■■■
function fetchCorosData() {
  console.log('\n' + '═'.repeat(48));
  console.log('  STEP 1/5  拉取 COROS 运动健康数据');
  console.log('═'.repeat(48));
  const out = {};
  const tasks = [
    ['userInfo',  'queryUserInfo',                     {}],
    ['fitness',   'queryFitnessAssessmentOverview',      {}],
    ['recovery',  'queryRecoveryStatus',                {}],
    ['restingHr', 'queryRestingHeartRate',             { days:7, timezone:'Asia/Shanghai' }],
    ['sleepData',  'querySleepData',                    { days:30, timezone:'Asia/Shanghai' }],
    // ★ v4: 传 startDate/endDate 获取全量运动记录（endDate 动态计算为今天）
    ['sportRecords','querySportRecords',               { startDate:'20260101', endDate: new Date().toISOString().slice(0,10).replace(/-/g,''), limit:200, timezone:'Asia/Shanghai' }],
    ['dailyHealth', 'queryDailyHealthData',           { days:30, timezone:'Asia/Shanghai' }],
  ];
  for (const [key, tool, args] of tasks) {
    process.stdout.write('  [coros] ' + key + ' ...');
    const v = corosCall(tool, args);
    out[key] = v || '';
    // 统计运动记录数
    if (key === 'sportRecords') {
      const cnt = (v.match(/\d+\.\s+Outdoor\s+Run/g) || []).length;
      console.log(' ✓ (' + cnt + ' records)');
    } else {
      console.log(v ? ' ✓' : ' ✗ empty');
    }
  }
  return out;
}

// ■■■ 2. 拉取墨墨数据 ■■■
function fetchMaiMemo() {
  console.log('\n' + '═'.repeat(48));
  console.log('  STEP 2/5  拉取墨墨背单词数据');
  console.log('═'.repeat(48));
  const progress   = maimemoCurl('/study/get_study_progress', {});
  const todayItems = maimemoCurl('/study/get_today_items', { limit: 200 });
  let totalWords = 0;
  const countRes = maimemoCurl('/study/query_study_records', { as_count: true });
  if (countRes && countRes.success && countRes.data) totalWords = countRes.data.count || 6001;
  console.log('  总词汇量: ' + totalWords);
  console.log('  学习进度: ' + (progress && progress.success ? '✓' : '✗'));
  console.log('  今日单词: ' + (todayItems && todayItems.success
    ? '✓ (' + (todayItems.data && todayItems.data.today_items
        ? todayItems.data.today_items.length : 0) + ')'
    : '✗'));
  let records = null;
  if (progress && progress.success) {
    records = maimemoCurl('/study/query_study_records', { limit: 200 });
    console.log('  学习记录: ' + (records && records.success
      ? '✓ (' + (records.data && records.data.records ? records.data.records.length : 0) + ')'
      : '-'));
  }
  return {
    progress: (progress && progress.data && progress.data.progress) || null,
    items:    (todayItems && todayItems.data && todayItems.data.today_items) || [],
    records:  (records && records.data && records.data.records) || [],
    totalWords: totalWords,
  };
}

// ■■■ 3. 解析 COROS 文本 → JS 对象 ■■■
function parseCoros(textBlocks) {
  const runs = [], allRuns = new Map(), sleepDays = [], sleepStages = [];
  let vo2max = 54, restingHr = 43, recovery = 100;

  // -- 运动记录（精确数据，来自 querySportRecords）--
  const sr = textBlocks.sportRecords || '';
  if (sr) {
    // 匹配格式: "#. SportType — date\n Duration: ... | Distance: X.XX km\n Average Pace: X:XX /km | Avg HR: XXX bpm"
    const re = /(\d+)\.\s+Outdoor\s+Run\s*—\s*(\d{4}-\d{2}-\d{2})[\s\S]*?Duration:\s*([\d:]+)\s*\|[\s\S]*?Distance:\s*([\d.]+)\s*km[\s\S]*?Average\s+Pace:\s*([\d:]+)\s*\/km[\s\S]*?Avg\s+HR:\s*(\d+)/g;
    let m;
    while ((m = re.exec(sr)) !== null) {
      const dateKey = m[2]; // YYYY-MM-DD
      const dist = parseFloat(m[4]);
      if (!dist || dist < 0.3) continue;

      const paceStr = m[5];
      const pp = paceStr.split(':');
      const pace = parseInt(pp[0]) + (parseInt(pp[1])||0)/60;
      const hr = parseInt(m[6]);

      const dateShort = dateKey.slice(5).replace('-','/');
      const existing = allRuns.get(dateKey);
      if (existing) {
        const totalDist = existing.dist + dist;
        const weightedPace = (existing.dist * existing.pace + dist * pace) / totalDist;
        const weightedHr = Math.round((existing.dist * existing.hr + dist * hr) / totalDist);
        allRuns.set(dateKey, {
          date: existing.date,
          dist: Math.round(totalDist * 100) / 100,
          pace: Math.round(weightedPace * 100) / 100,
          hr: weightedHr,
          hasDetail: true,
        });
      } else {
        allRuns.set(dateKey, {
          date: dateShort,
          dist: dist,
          pace: Math.round(pace * 100) / 100,
          hr: hr,
          hasDetail: true,
        });
      }
    }
  }

  // -- 每日健康数据（补全 sportRecords 中缺失的跑步日）--
  const dh = textBlocks.dailyHealth || '';
  if (dh && dh.includes('Daily Health Data')) {
    const dhBlocks = dh.split(/(?=---\s*\d{8}\s*---)/);
    let filledCount = 0;
    for (let i = 0; i < dhBlocks.length; i++) {
      const block = dhBlocks[i];
      const dm = block.match(/---\s*(\d{4})(\d{2})(\d{2})\s*---/);
      if (!dm) continue;
      const dateKey = dm[1] + '-' + dm[2] + '-' + dm[3];

      // 跳过已有精确数据的日期
      if (allRuns.has(dateKey)) continue;

      const em = block.match(/Exercise:\s*(?:(\d+)h\s*)?(\d+)\s*min/);
      if (!em) continue;
      const h = parseInt(em[1] || '0');
      const exMin = h * 60 + parseInt(em[2]);
      if (exMin < 15) continue;

      // 估算距离（用基线配速）
      const estDist = Math.round(exMin / 6 * 100) / 100;

      allRuns.set(dateKey, {
        date: dateKey.slice(5).replace('-','/'),
        dist: estDist,
        pace: 0,   // 无精确数据
        hr: 0,     // 无精确数据
        hasDetail: false,
      });
      filledCount++;
    }
    if (filledCount > 0) console.log('  每日健康补全: ' + filledCount + ' 天');
  }

  // 转为数组并按日期排序
  const runsArr = Array.from(allRuns.values());
  runsArr.sort(function(a, b) {
    var da = new Date('2020-' + a.date.replace('/','-'));
    var db = new Date('2020-' + b.date.replace('/','-'));
    return da - db;
  });

  // 取最近 30 天给 runs
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0,10);
  const detailCount = runsArr.filter(r => r.hasDetail).length;
  const estCount = runsArr.filter(r => !r.hasDetail).length;
  console.log('  总运动记录: ' + runsArr.length + ' (精确: ' + detailCount + ', 估算: ' + estCount + ')');

  for (let i = 0; i < runsArr.length; i++) {
    var d = new Date(cutoffStr.slice(0,4) + '-' + runsArr[i].date.replace('/','-'));
    if (d >= cutoff) runs.push(runsArr[i]);
  }

  // -- 睡眠 --
  const sl = textBlocks.sleepData || '';
  if (sl && sl.includes('Sleep Data')) {
    const re2 = /(\d{4}-\d{2}-\d{2})[\s\S]*?Sleep Score:\s*(-?\d+)[\s\S]*?Main Sleep:\s*(\d+)h\s*(\d+)min/g;
    let m;
    while ((m = re2.exec(sl)) !== null) {
      sleepDays.push({
        date: m[1].slice(5),
        score: parseInt(m[2]),
        h: Math.round((parseInt(m[3]) + parseInt(m[4])/60)*100)/100,
      });
    }
    const re3 = /(\d{4}-\d{2}-\d{2})[\s\S]*?Deep Sleep Ratio:\s*(\d+)%[\s\S]*?Light Sleep Ratio:\s*(\d+)%[\s\S]*?REM Ratio:\s*(\d+)%[\s\S]*?Awake Ratio:\s*(\d+)%/g;
    while ((m = re3.exec(sl)) !== null) {
      const d = m[1].slice(5).replace('-','/');
      if (d.endsWith('17')) continue;
      sleepStages.push({
        date: d,
        deep: parseInt(m[2]), light: parseInt(m[3]),
        rem: parseInt(m[4]), awake: parseInt(m[5]),
      });
    }
  }

  // -- 指标 --
  const ft = textBlocks.fitness || '';
  const m1 = ft.match(/VO2max:\s*(\d+)/);
  if (m1) vo2max = parseInt(m1[1]);

  const rt = textBlocks.recovery || '';
  const m2 = rt.match(/Recovery:\s*(\d+)/);
  if (m2) recovery = parseInt(m2[1]);

  const rh = textBlocks.restingHr || '';
  const m3 = rh.match(/(\d{4}-\d{2}-\d{2}):\s*(\d+)\s*bpm/);
  if (m3) restingHr = parseInt(m3[2]);

  return { runs, allRuns: runsArr, sleepDays, sleepStages, vo2max, restingHr, recovery };
}

// ■■■ 4. 写入 dashboard.html ■■■
function updateDashboard(data) {
  console.log('\n' + '═'.repeat(48));
  console.log('  STEP 3/5  更新 dashboard.html');
  console.log('═'.repeat(48));
  let html = fs.readFileSync(DASHBOARD, 'utf8');

  const now = new Date().toISOString().slice(0,10);

  // 指标卡片
  html = html.replace(
    /(<div class="metric-value blue">)\d+(<\/div>)/,
    '$1' + data.vo2max + '$2'
  );
  html = html.replace(
    /(<div class="metric-value green">)\d+(<span class="metric-unit">bpm<\/span>)/,
    '$1' + data.restingHr + '$2'
  );
  html = html.replace(
    /(<div class="metric-value green">)\d+(<span class="metric-unit">%<\/span>)/,
    '$1' + data.recovery + '$2'
  );

  // JS 数组
  const reps = [
    ['const runs = ',               'runs'],
    ['const allRuns = ',           'allRuns'],
    ['const sleepDays = ',         'sleepDays'],
    ['const sleepStagesData = ',   'sleepStages'],
  ];
  for (const [prefix, key] of reps) {
    if (!data[key] || data[key].length === 0) continue;
    const re = new RegExp(escapeForRegex(prefix) + '\\[[\\s\\S]*?\\];', 'm');
    html = html.replace(re, prefix + JSON.stringify(data[key], null, 2).replace(/\n/g, '\n  ') + ';');
  }

  // 时间戳
  html = html.replace(
    /数据同步自 COROS 云端 · \d{4}-\d{2}-\d{2}/,
    '数据同步自 COROS 云端 · ' + now
  );
  html = html.replace(
    /更新于 \d{4}-\d{2}-\d{2}/,
    '更新于 ' + now
  );

  fs.writeFileSync(DASHBOARD, html, 'utf8');
  console.log('  ✓ dashboard.html 已更新 (' + data.runs.length + ' 条近期跑步记录)');
  return true;
}

// ■■■ 5. 写入 memo.html ■■■
function updateMemo(memo) {
  console.log('\n' + '═'.repeat(48));
  console.log('  STEP 4/5  更新 memo.html');
  console.log('═'.repeat(48));
  if (!memo.progress || !memo.items || !memo.items.length) {
    console.log('  数据不足，跳过');
    return false;
  }
  let html = fs.readFileSync(MEMO, 'utf8');
  const now  = new Date().toISOString().slice(0, 10);
  const p    = memo.progress;
  // 批量获取释义（优先自定义，回退到 MyMemory 翻译）
  const defs = {};
  if (memo.items && memo.items.length) {
    const vocIds = memo.items.map(it => it.voc_id).filter(Boolean);
    console.log('  获取释义中 (' + vocIds.length + ' 词)...');
    // 1. 先查自定义释义
    let fetched = 0;
    for (const vid of vocIds) {
      try {
        const url = 'https://open.maimemo.com/open/api/v1/interpretations?voc_id=' + encodeURIComponent(vid);
        const raw = run('curl -s --noproxy "*" --max-time 5 "' + url + '" -H "Authorization: Bearer ' + MAIMEMO_TOKEN + '"');
        if (raw) {
          const j = JSON.parse(raw);
          if (j.success && j.data && j.data.interpretations && j.data.interpretations.length) {
            defs[vid] = j.data.interpretations[0].interpretation;
          }
        }
      } catch(e) {}
      fetched++;
      if (fetched % 10 === 0) process.stdout.write(' ' + fetched);
    }
    // 2. 无自定义释义的词汇用 MyMemory 翻译
    const missing = memo.items.filter(it => !defs[it.voc_id]).map(it => it.voc_spelling);
    if (missing.length) {
      console.log('');
      process.stdout.write('  MyMemory 翻译中 (' + missing.length + ' 词)...');
      let translated = 0;
      for (const word of missing) {
        try {
          const raw = run('curl -s --noproxy "*" --max-time 5 "https://api.mymemory.translated.net/get?q=' + encodeURIComponent(word) + '&langpair=en|zh"');
          if (raw) {
            const j = JSON.parse(raw);
            const zh = j.responseData && j.responseData.translatedText;
            if (zh) {
              // 把翻译结果关联到该词对应的 items
              memo.items.filter(it => it.voc_spelling === word).forEach(it => { defs[it.voc_id] = zh; });
            }
          }
        } catch(e) {}
        translated++;
        if (translated % 10 === 0) process.stdout.write(' ' + translated);
      }
    }
    console.log('  ✓ (' + Object.keys(defs).length + ' 词有释义)');
  }

  const RESP_MAP = { FAMILIAR:0, FORGET:1, VAGUE:2 };
  const items = memo.items.map(function(it) {
    return {
      spelling: it.voc_spelling || '',
      translation: defs[it.voc_id] || '',
      vocId: it.voc_id || '',
      response: RESP_MAP[(it.first_response||'').toUpperCase()] || 0,
      isNew: !!it.is_new,
      order: it.order || 0,
    };
  });
  const recs = memo.records.map(function(it) {
    return {
      count: it.study_count || 0,
      lastResp: it.last_response || 'FAMILIAR',
      lastDate: it.last_study_date ? it.last_study_date.slice(0,10) : '',
      tags: it.tags || [],
    };
  });

  html = html.replace(
    /const memoData = \{[\s\S]*?\};/m,
    'const memoData = {\n' +
    '  finished: ' + (p.finished||0) + ', total: ' + (p.total||p.finished||0) + ',\n' +
    '  studyTimeMs: ' + (p.study_time||0) + ', totalWords: ' + (memo.totalWords || 0) + ',\n' +
    '  todayItems: ' + JSON.stringify(items) + '\n};'
  );

  html = html.replace(
    /<div class="card-title" id="labelWordTitle">[^<]*<\/div>/,
    '<div class="card-title" id="labelWordTitle">今日全部 ' + (p.total || p.finished || 50) + ' 词</div>'
  );
  html = html.replace(
    /<div class="card-sub" id="labelRespSub">[^<]*<\/div>/,
    '<div class="card-sub" id="labelRespSub">今日 ' + (p.total || p.finished || 50) + ' 词首次反应</div>'
  );

  // 计算所有动态数值
  const nNew2    = items.filter(i => i.isNew).length;
  const nFam2    = items.filter(i => i.response === 0).length;
  const nForget2 = items.filter(i => i.response === 1).length;
  const nVague2  = items.filter(i => i.response === 2).length;
  const mins2    = Math.round((p.study_time || 0) / 60000 * 10) / 10;
  const famPct2  = items.length ? Math.round(nFam2 / items.length * 100) : 0;

  // 清除 metric-card 硬编码（允许内部有 span 子元素）
  html = html.replace(/<div class="metric-value green" id="mProgress">[\s\S]*?<\/div>/,
    '<div class="metric-value green" id="mProgress">' + (p.finished||0) + '<span class="metric-unit">/' + (p.total||p.finished||0) + '</span></div>');
  html = html.replace(/<div class="metric-value blue" id="mTime">[\s\S]*?<\/div>/,
    '<div class="metric-value blue" id="mTime">' + mins2 + '<span class="metric-unit">min</span></div>');
  html = html.replace(/<div class="metric-value amber" id="mNew">[\s\S]*?<\/div>/,
    '<div class="metric-value amber" id="mNew">' + nNew2 + '</div>');
  html = html.replace(/<div class="metric-value purple" id="mAccu">[\s\S]*?<\/div>/,
    '<div class="metric-value purple" id="mAccu">' + famPct2 + '<span class="metric-unit">%</span></div>');
  html = html.replace(/<div class="metric-value" id="mTotal"[^>]*>[\s\S]*?<\/div>/,
    '<div class="metric-value" id="mTotal" style="color:#2c2c2a">' + (memo.totalWords || 0) + '</div>');
  html = html.replace(/<div class="metric-value red" id="mReview">[\s\S]*?<\/div>/,
    '<div class="metric-value red" id="mReview">' + (nForget2 + nVague2) + '</div>');

  // 清除 ring-stats 硬编码
  const ringHtml = '<div class="ring-stats">' +
    '<div class="stat-row"><span class="stat-num green">' + (p.finished||0) + '/' + (p.total||p.finished||0) + '</span><span class="stat-label">今日目标</span><span class="stat-sub">' + famPct2 + '% 完成</span></div>' +
    '<div class="stat-row"><span class="stat-num blue">' + mins2 + 'min</span><span class="stat-label">学习时长</span></div>' +
    '<div class="stat-row"><span class="stat-num amber">' + nNew2 + '</span><span class="stat-label">新学词汇</span><span class="stat-sub">' + (items.length - nNew2) + ' 个复习</span></div>' +
    '<div class="stat-row"><span class="stat-num red">' + (nForget2 + nVague2) + '</span><span class="stat-label">需关注</span><span class="stat-sub">' + nForget2 + ' 忘记 · ' + nVague2 + ' 模糊</span></div>' +
    '</div>';
  html = html.replace('__RING_STATS__', ringHtml);

  html = html.replace(
    /const studyRecords = \[[\s\S]*?\];/m,
    'const studyRecords = ' + JSON.stringify(recs, null, 2) + ';'
  );

  html = html.replace(/已同步.*$/, '已同步 · ' + now);

  // 维护学习日志（每日自动记录）
  let log = [];
  try { log = JSON.parse(fs.readFileSync(STUDY_LOG, 'utf8')); } catch(e) {}
  const todayKey = now.slice(5).replace('-','/');
  const todayMins = Math.round((p.study_time || 0) / 60000 * 10) / 10;
  // 更新或追加今日记录
  const existIdx = log.findIndex(e => e.date === todayKey);
  if (existIdx >= 0) log[existIdx] = { date: todayKey, mins: todayMins, words: p.total || 50 };
  else log.push({ date: todayKey, mins: todayMins, words: p.total || 50 });
  if (log.length > 14) log = log.slice(-14);
  fs.writeFileSync(STUDY_LOG, JSON.stringify(log), 'utf8');
  // 注入到 HTML
  html = html.replace(
    /const studyLog = \[[\s\S]*?\];/m,
    'const studyLog = ' + JSON.stringify(log) + ';'
  );
  console.log('  学习日志: ' + log.length + ' 天');

  fs.writeFileSync(MEMO, html, 'utf8');
  console.log('  ✓ memo.html 已更新');
  return true;
}

// ■■■ 6. Git 提交 & 推送 ■■■
function gitDeploy() {
  console.log('\n' + '═'.repeat(48));
  console.log('  STEP 5/5  Git 提交 & 推送');
  console.log('═'.repeat(48));
  run('git add dashboard.html memo.html');
  const diff = run('git diff --cached --stat') || '';
  if (!diff.trim()) { console.log('  无变化，跳过提交'); return false; }
  const ts = new Date().toISOString().slice(0,16).replace('T',' ');
  run('git commit -m "auto-update: ' + ts + '"');
  run('git push');
  console.log('\n  ✓ 已推送！GitHub Pages 约 1~2 分钟后生效\n');
  console.log('  运动健康: https://yifeigit.github.io/personal-dashboard/dashboard.html');
  console.log('  背单词:   https://yifeigit.github.io/personal-dashboard/memo.html');
  return true;
}

function escapeForRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function logTitle(s) { console.log('\n' + '═'.repeat(48) + '\n  ' + s + '\n' + '═'.repeat(48)); }

// ===== 主流程 =====
(function() {
  const line = '╔' + '═'.repeat(36) + '╗';
  const mid  = '║' + ' 仪表盘数据一键更新工具  v4'.padEnd(38) + '║';
  const line2= '╚' + '═'.repeat(36) + '╝';
  console.log('\n' + line + '\n' + mid + '\n' + line2);

  const coros = fetchCorosData();
  const memo  = fetchMaiMemo();

  const dashData = parseCoros(coros);
  updateDashboard(dashData);
  updateMemo(memo);
  gitDeploy();

  logTitle('完成! 大量精确数据已就绪   ');
})();
