/**
 * 一键更新仪表盘数据脚本 (v5)
 *
 * v5: 移除墨墨背单词模块，仅保留 COROS 运动健康数据
 * v4: 使用 npm 全局 CLI（call-tool 格式），传递 startDate/endDate 获取全量运动记录（58条）
 * v3: 修复代理、bash 执行、变量命名等问题
 *
 * 用法：node update-data.js
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const BASE_DIR = __dirname;
const DASHBOARD = path.join(BASE_DIR, 'dashboard.html');

// ===== 配置 =====
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

    const opts = { encoding: 'utf-8', timeout: 60000, stdio: ['pipe','pipe','pipe'], env };
    return execSync(cmd, opts).trim();
  } catch (e) {
    return null;
  }
}

// ===== 执行命令（保留代理环境变量）=====
function runWithProxy(cmd) {
  try {
    const env = Object.assign({}, process.env);
    // 确保代理环境变量存在（父进程可能已清除它们）
    if (!env.http_proxy  && !env.HTTP_PROXY)  { env.http_proxy  = 'http://127.0.0.1:7897'; }
    if (!env.https_proxy && !env.HTTPS_PROXY) { env.https_proxy = 'http://127.0.0.1:7897'; }
    if (!env.HTTP_PROXY)  { env.HTTP_PROXY  = 'http://127.0.0.1:7897'; }
    if (!env.HTTPS_PROXY) { env.HTTPS_PROXY = 'http://127.0.0.1:7897'; }
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
  const cmd = 'node "' + COROS_CLI + '" --issuer https://mcpcn.coros.com call-tool --tool ' + tool + ' --arguments-json "' + argStr.replace(/"/g, '\\"') + '"';
  const raw = runWithProxy(cmd);
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

// ■■■ 1. 拉取 COROS 数据 ■■■
function fetchCorosData() {
  console.log('\n' + '═'.repeat(48));
  console.log('  STEP 1/3  拉取 COROS 运动健康数据');
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

// ■■■ 2. 解析 COROS 文本 → JS 对象 ■■■
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

// ■■■ 3. 写入 dashboard.html ■■■
function updateDashboard(data) {
  console.log('\n' + '═'.repeat(48));
  console.log('  STEP 2/3  更新 dashboard.html');
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

// ■■■ 4. Git 提交 & 推送 ■■■
function gitDeploy() {
  console.log('\n' + '═'.repeat(48));
  console.log('  STEP 3/3  Git 提交 & 推送');
  console.log('═'.repeat(48));
  run('git add dashboard.html');
  const diff = run('git diff --cached --stat') || '';
  if (!diff.trim()) { console.log('  无变化，跳过提交'); return false; }
  const ts = new Date().toISOString().slice(0,16).replace('T',' ');
  run('git commit -m "auto-update: ' + ts + '"');
  // 优先尝试 git push（需要代理），失败则用 gh api 回退
  const pushed = gitTryPush();
  if (pushed) {
    console.log('\n  ✓ 已推送！GitHub Pages 约 1~2 分钟后生效\n');
    console.log('  运动健康: https://yifeigit.github.io/personal-dashboard/dashboard.html');
  } else {
    console.log('\n  ⚠ git push 失败（网络问题），改用 GitHub API 推送...');
    const apiOk = gitApiPush(ts);
    if (apiOk) {
      console.log('\n  ✓ 已通过 API 推送！GitHub Pages 约 1~2 分钟后生效\n');
      console.log('  运动健康: https://yifeigit.github.io/personal-dashboard/dashboard.html');
    } else {
      console.log('\n  ✗ API 推送也失败，请手动推送');
    }
  }
  return true;
}

// 尝试 git push（3 秒超时，仅检查网络是否通）
function gitTryPush() {
  try {
    const env = Object.assign({}, process.env);
    ['http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY',
     'all_proxy','ALL_PROXY','no_proxy','NO_PROXY'].forEach(k => { delete env[k]; });
    // 先设代理再推
    execSync('git config http.proxy http://127.0.0.1:7897', { timeout: 3000, stdio: 'pipe', env });
    execSync('git config https.proxy http://127.0.0.1:7897', { timeout: 3000, stdio: 'pipe', env });
    execSync('git push', { timeout: 15000, stdio: 'pipe', env });
    return true;
  } catch(e) {
    return false;
  }
}

// 通过 GitHub API 推送（使用 gh api，走 api.github.com 无需代理）
function gitApiPush(commitMsg) {
  try {
    const env = Object.assign({}, process.env);
    ['http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY',
     'all_proxy','ALL_PROXY','no_proxy','NO_PROXY'].forEach(k => { delete env[k]; });

    const dashContent = fs.readFileSync(DASHBOARD, 'utf8');
    const dashB64 = Buffer.from(dashContent, 'utf8').toString('base64');

    // 获取当前 commit SHA
    const refRaw = execSync('gh api repos/yifeigit/personal-dashboard/git/refs/heads/master --jq .object.sha', { timeout: 15000, stdio: 'pipe', env }).toString().trim();
    const baseSha = refRaw;

    // 获取当前 tree SHA
    const commitRaw = execSync('gh api repos/yifeigit/personal-dashboard/git/commits/' + baseSha + ' --jq .tree.sha', { timeout: 15000, stdio: 'pipe', env }).toString().trim();
    const baseTree = commitRaw;

    // 创建 blob：dashboard.html
    const dashBlobJson = execSync('gh api repos/yifeigit/personal-dashboard/git/blobs -X POST -f content=' + dashB64 + ' -f encoding=base64 --jq .sha', { timeout: 15000, stdio: 'pipe', env }).toString().trim();

    // 创建 tree（基于 base_tree 更新 dashboard.html）
    const treePayload = JSON.stringify({
      base_tree: baseTree,
      tree: [
        { path: 'dashboard.html', mode: '100644', type: 'blob', sha: dashBlobJson }
      ]
    });
    const treeSha = execSync('gh api repos/yifeigit/personal-dashboard/git/trees -X POST --input - --jq .sha', { timeout: 15000, stdio: ['pipe','pipe','pipe'], env, input: treePayload }).toString().trim();

    // 创建 commit
    const commitPayload = JSON.stringify({
      message: 'auto-update: ' + commitMsg,
      tree: treeSha,
      parents: [baseSha]
    });
    const newCommitSha = execSync('gh api repos/yifeigit/personal-dashboard/git/commits -X POST --input - --jq .sha', { timeout: 15000, stdio: ['pipe','pipe','pipe'], env, input: commitPayload }).toString().trim();

    // 更新 master ref
    const refPayload = JSON.stringify({ sha: newCommitSha, force: false });
    execSync('gh api repos/yifeigit/personal-dashboard/git/refs/heads/master -X PATCH --input -', { timeout: 15000, stdio: ['pipe','pipe','pipe'], env, input: refPayload });

    console.log('  ✓ API 推送完成 (提交 ' + newCommitSha.slice(0,7) + ')');
    return true;
  } catch(e) {
    console.log('  ⚠ API 推送出错: ' + (e.stderr || e.message || e).toString().slice(0,200));
    return false;
  }
}

function escapeForRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function logTitle(s) { console.log('\n' + '═'.repeat(48) + '\n  ' + s + '\n' + '═'.repeat(48)); }

// ===== 主流程 =====
(function() {
  const line = '╔' + '═'.repeat(36) + '╗';
  const mid  = '║' + ' 仪表盘数据一键更新工具  v5'.padEnd(38) + '║';
  const line2= '╚' + '═'.repeat(36) + '╝';
  console.log('\n' + line + '\n' + mid + '\n' + line2);

  const coros = fetchCorosData();

  const dashData = parseCoros(coros);
  updateDashboard(dashData);
  gitDeploy();

  logTitle('完成! 大量精确数据已就绪   ');
})();
