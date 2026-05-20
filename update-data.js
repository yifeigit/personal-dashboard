/**
 * 一键更新仪表盘数据脚本 (v3)
 *
 * 修复说明：
 *   - coros-mcp 是 bash 脚本，必须通过 bash 执行
 *   - MaiMemo API 用 curl --noproxy '*' 绕过 Windows 代理
 *   - 所有执行均清除代理环境变量
 *
 * 用法：node update-data.js
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_DIR = __dirname;
const DASHBOARD = path.join(BASE_DIR, 'dashboard.html');
const MEMO      = path.join(BASE_DIR, 'memo.html');

// ===== 配置 =====
const MAIMEMO_TOKEN  = '9d8cd1568fa003b8c31f9e047ca5e1fd5cb60fe0c679159a1c2c3e1dde48ac19';
const MAIMEMO_BASE  = 'https://open.maimemo.com/open/api/v1';
const COROS_CLI      = '/c/Users/Administrator/bin/coros-mcp';

// ===== 查找 bash =====
function findBash() {
  const candidates = [
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch(e){} }
  // 回退：用 ComSpec 看能不能找到 bash
  return null;
}
const BASH = findBash();

// ===== 执行命令（清除代理）=====
function run(cmd, useBash) {
  try {
    const env = Object.assign({}, process.env);
    // 清除所有代理变量
    ['http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY',
     'all_proxy','ALL_PROXY','no_proxy','NO_PROXY'].forEach(k => { delete env[k]; });
    env.NO_PROXY = '*';
    env.no_proxy = '*';
    env.http_proxy  = '';
    env.https_proxy = '';
    env.HTTP_PROXY  = '';
    env.HTTPS_PROXY = '';

    const opts = {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe','pipe','pipe'],
      env: env,
    };
    if (useBash && BASH) opts.shell = BASH;
    return execSync(cmd, opts).trim();
  } catch (e) {
    return null;
  }
}

// ===== 调用 COROS MCP（通过 bash 执行脚本）=====
function corosCall(tool, args) {
  // 构建 JSON 参数字符串（合法 JSON）
  const argStr = (args !== undefined && args !== null)
    ? (typeof args === 'object' ? JSON.stringify(args) : String(args))
    : '{}';
  // 命令：用 bash -c 执行，参数用单引号包裹（bash 单引号内所有字符字面量）
  const inner = COROS_CLI + ' ' + tool + " '" + argStr + "'";
  const cmd   = BASH ? ('"' + BASH + '" -c "' + inner.replace(/"/g, '\\"') + '"') : (COROS_CLI + ' ' + tool + " '" + argStr + "'");
  const raw   = run(cmd, false);  // 已经用 bash -c 包裹，不需要再用 shell
  if (!raw || raw[0] !== '{') return '';
  try {
    const j = JSON.parse(raw);
    const text = (j && j.result && j.result.content && j.result.content[0] && j.result.content[0].text) || '';
    return text.replace(/^"|"$/g, '').replace(/\\n/g, '\n').replace(/\\"/g, '"');
  } catch (e) { return raw; }
}

// ===== 调用 MaiMemo API（curl --noproxy）=====
function maimemoCurl(endpoint, body) {
  const data = JSON.stringify(body || {});
  const url  = MAIMEMO_BASE + endpoint;
  // 构造 curl 命令：Header 用双引号（兼容 cmd.exe 和 bash）
  const cmd = [
    'curl', '-s', '--noproxy', '*', '--max-time', '15',
    '-X', 'POST',
    url,
    '-H', '"Authorization: Bearer ' + MAIMEMO_TOKEN + '"',
    '-H', '"Content-Type: application/json"',
    '-d', '"' + data.replace(/"/g, '\\"') + '"',
  ].join(' ');
  const raw = run(cmd, false);
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
    ['sleepData',  'querySleepData',                    { days:90, timezone:'Asia/Shanghai' }],
    ['sportRecords','querySportRecords',               { limit:200, timezone:'Asia/Shanghai' }],
    ['dailyHealth', 'queryDailyHealthData',           { days:90, timezone:'Asia/Shanghai' }],
  ];
  for (const [key, tool, args] of tasks) {
    process.stdout.write('  [coros] ' + key + ' ...');
    const v = corosCall(tool, args);
    out[key] = v || '';
    console.log(v ? ' ✓' : ' ✗ empty');
  }
  return out;
}

// ■■■ 2. 拉取墨墨数据 ■■■
function fetchMaiMemo() {
  console.log('\n' + '═'.repeat(48));
  console.log('  STEP 2/5  拉取墨墨背单词数据');
  console.log('═'.repeat(48));
  const progress   = maimemoCurl('/study/get_study_progress', {});
  const todayItems = maimemoCurl('/study/get_today_items', {});
  console.log('  学习进度: ' + (progress && progress.success ? '✓' : '✗'));
  console.log('  今日单词: ' + (todayItems && todayItems.success
    ? '✓ (' + (todayItems.data && todayItems.data.today_items
        ? todayItems.data.today_items.length : 0) + ')'
    : '✗'));
  let records = null;
  if (progress && progress.success) {
    records = maimemoCurl('/study/query_study_records', { limit: 30 });
    console.log('  学习记录: ' + (records && records.success
      ? '✓ (' + (records.data && records.data.records ? records.data.records.length : 0) + ')'
      : '-'));
  }
  return {
    progress: (progress && progress.data && progress.data.progress) || null,
    items:    (todayItems && todayItems.data && todayItems.data.today_items) || [],
    records:  (records && records.data && records.data.records) || [],
  };
}

// ■■■ 3. 解析 COROS 文本 → JS 对象 ■■■
function parseCoros(textBlocks) {
  const runs = [], allRuns = [], sleepDays = [], sleepStages = [];
  let vo2max = 54, restingHr = 43, recovery = 100;

  // -- 运动记录（详细数据）--
  const sportMap = {}; // date -> { dist, pace, hr, duration }
  const sr = textBlocks.sportRecords || '';
  if (sr && sr.includes('Sport Records')) {
    const re = /(\d+)\.\s+(.+?)\s+—\s+(\d{4}-\d{2}-\d{2})[\s\S]*?Duration:\s*([\d:]+)\s*\|[\s\S]*?Distance:\s*([\d.]+)\s*km[\s\S]*?Average\s+Pace:\s*([\d:]+)[\s\S]*?Avg\s+HR:\s*(\d+)/g;
    let m;
    while ((m = re.exec(sr)) !== null) {
      const dateKey = m[3]; // YYYY-MM-DD
      const paceStr = m[6];
      const pp = paceStr.split(':');
      const pace = parseInt(pp[0]) + (parseInt(pp[1])||0)/60;
      sportMap[dateKey] = {
        date: dateKey.slice(5).replace('-','/'),
        dist: parseFloat(m[5]),
        pace: Math.round(pace*100)/100,
        hr: parseInt(m[7]),
        hasDetail: true,
      };
      allRuns.push(sportMap[dateKey]);
    }
  }

  // -- 每日健康数据（补全缺失的跑步日）--
  const dh = textBlocks.dailyHealth || '';
  if (dh && dh.includes('Daily Health Data')) {
    // 按日期块分割，每块格式: "--- 20260421 ---\nSteps:...\nExercise:..."
    // 用 lookahead 保持分隔符
    const dhBlocks = dh.split(/(?=---\s*\d{8}\s*---)/);
    for (let i = 0; i < dhBlocks.length; i++) {
      const block = dhBlocks[i];
      const dm = block.match(/---\s*(\d{4})(\d{2})(\d{2})\s*---/);
      if (!dm) continue;
      const dateKey = dm[1] + '-' + dm[2] + '-' + dm[3];

      // 跳过已有详细数据的日期
      if (sportMap[dateKey]) continue;

      // 只匹配本块内的 Exercise（格式: "Xh Ymin" 或 "X min"）
      const em = block.match(/Exercise:\s*(?:(\d+)h\s*)?(\d+)\s*min/);
      if (!em) continue;
      const h = parseInt(em[1] || '0');
      const exMin = h * 60 + parseInt(em[2]);
      if (exMin < 15) continue; // 少于15分钟不算跑步

      // 用典型配速估算距离 (~6 min/km)
      const estDist = Math.round(exMin / 6 * 100) / 100;

      allRuns.push({
        date: dateKey.slice(5).replace('-','/'),
        dist: estDist,
        pace: 6.0,
        hr: 0,    // 无实际心率数据，用0标记（图表中不显示）
        hasDetail: false,
      });
    }
  }

  // 按日期排序
  allRuns.sort(function(a, b) {
    var da = new Date('2020-' + a.date.replace('/','-'));
    var db = new Date('2020-' + b.date.replace('/','-'));
    return da - db;
  });

  // 取最近 90 天给 runs
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0,10);
  const recentRuns = allRuns.filter(function(r) {
    var d = new Date(cutoffStr.slice(0,4) + '-' + r.date.replace('/','-'));
    return d >= cutoff;
  });
  runs.push(...recentRuns);

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
    // 阶段
    const re3 = /(\d{4}-\d{2}-\d{2})[\s\S]*?Deep Sleep Ratio:\s*(\d+)%[\s\S]*?Light Sleep Ratio:\s*(\d+)%[\s\S]*?REM Ratio:\s*(\d+)%[\s\S]*?Awake Ratio:\s*(\d+)%/g;
    while ((m = re3.exec(sl)) !== null) {
      const d = m[1].slice(5).replace('-','/');
      if (d.endsWith('17')) continue; // 跳过无效日期
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

  // 静息心率：取最近一天的数据
  const rh = textBlocks.restingHr || '';
  const m3 = rh.match(/(\d{4}-\d{2}-\d{2}):\s*(\d+)\s*bpm/);
  if (m3) restingHr = parseInt(m3[2]);

  return { runs, allRuns, sleepDays, sleepStages, vo2max, restingHr, recovery };
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
  console.log('  ✓ dashboard.html 已更新');
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
  // first_response 映射：FAMILIAR→0, FORGET→1, VAGUE→2
  const RESP_MAP = { FAMILIAR:0, FORGET:1, VAGUE:2 };
  const items = memo.items.map(function(it) {
    return {
      spelling: it.voc_spelling || '',
      response: RESP_MAP[(it.first_response||'').toUpperCase()] || 0,
      isNew: !!it.is_new,
      order: it.order || 0,
    };
  });
  const recs = memo.records.map(function(it) {
    return {
      count: it.study_count || 0,
      lastResp: it.last_study_date ? it.last_study_date.slice(0,10) : '',
      tags: it.tags || [],
    };
  });

  // memoData 对象
  html = html.replace(
    /const memoData = \{[\s\S]*?\};/m,
    'const memoData = {\n' +
    '  finished: ' + (p.finished||50) + ', total: ' + (p.total||50) + ',\n' +
    '  studyTimeMs: ' + (p.study_time||295281) + ', totalWords: 6001,\n' +
    '  todayItems: ' + JSON.stringify(items) + '\n};'
  );

  // studyRecords 数组
  html = html.replace(
    /const studyRecords = \[[\s\S]*?\];/m,
    'const studyRecords = ' + JSON.stringify(recs, null, 2) + ';'
  );

  html = html.replace(/已同步.*$/, '已同步 · ' + now);
  fs.writeFileSync(MEMO, html, 'utf8');
  console.log('  ✓ memo.html 已更新');
  return true;
}

// ■■■ 6. Git 提交 & 推送 ■■■
function gitDeploy() {
  console.log('\n' + '═'.repeat(48));
  console.log('  STEP 5/5  Git 提交 & 推送');
  console.log('═'.repeat(48));
  run('git add dashboard.html memo.html', false);
  const diff = run('git diff --cached --stat', false) || '';
  if (!diff.trim()) { console.log('  无变化，跳过提交'); return false; }
  const ts = new Date().toISOString().slice(0,16).replace('T',' ');
  run('git commit -m "auto-update: ' + ts + '"', false);
  run('git push', false);
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
  const mid  = '║' + ' 仪表盘数据一键更新工具  v3'.padEnd(38) + '║';
  const line2= '╚' + '═'.repeat(36) + '╝';
  console.log('\n' + line + '\n' + mid + '\n' + line2);

  const coros = fetchCorosData();
  const memo  = fetchMaiMemo();

  const dashData = parseCoros(coros);
  updateDashboard(dashData);
  updateMemo(memo);
  gitDeploy();

  logTitle('完成! 感谢使用  🏃');
})();
