const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const service115 = require('./service115');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// --- 数据存储 ---
const DATA_ROOT = path.resolve(__dirname, '../data');
const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json');
const TASKS_FILE = path.join(DATA_ROOT, 'tasks.json');

console.log(`[System] 启动中... 数据目录: ${DATA_ROOT}`);

// 2. 确保数据根目录存在
if (!fs.existsSync(DATA_ROOT)) {
    try {
        fs.mkdirSync(DATA_ROOT, { recursive: true });
        console.log("[System] 已创建数据目录");
    } catch(e) {
        console.error("[System] ❌ 无法创建数据目录 (权限错误):", e.message);
    }
}

// --- 全局缓存 ---
let globalSettings = { cookie: "", rootCid: "0", rootName: "根目录", adminUser: "admin", adminPass: "admin" };
let globalTasks = [];
let cronJobs = {};

// 初始化：恢复之前的 Cron 任务
function initSystem() {
    if (fs.existsSync(SETTINGS_FILE)) {
        try { 
            const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE));
            globalSettings = { ...globalSettings, ...saved }; // 合并配置，确保新字段有默认值
        } catch(e) {}
    }
    if (fs.existsSync(TASKS_FILE)) {
        try {
            globalTasks = JSON.parse(fs.readFileSync(TASKS_FILE));
            globalTasks.forEach(t => {
                if (t.cronExpression && t.status !== 'stopped') startCronJob(t);
            });
            console.log(`[System] 已加载 ${globalTasks.length} 个任务`);
        } catch (e) {
            console.error("[System] 初始化数据读取失败:", e);
        }
    }
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(globalSettings, null, 2));
}
function saveTasks() {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(globalTasks, null, 2));
}

// 管理员权限验证
const requireAdmin = (req, res, next) => {
    const token = req.headers['x-admin-token'];
    if (token === globalSettings.adminPass) return next();
    res.status(403).json({ success: false, msg: "需要管理员权限" });
};

// --- API 接口 ---

// 1. 管理员登录
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === globalSettings.adminUser && password === globalSettings.adminPass) {
        res.json({ success: true, token: globalSettings.adminPass });
    } else {
        res.status(401).json({ success: false, msg: "用户名或密码错误" });
    }
});

// 2. 获取设置 (需管理员)
app.get('/api/settings', requireAdmin, (req, res) => {
    res.json({ success: true, data: globalSettings });
});

// 3. 保存设置 (需管理员)
app.post('/api/settings', requireAdmin, async (req, res) => {
    const { cookie, rootCid, rootName, adminUser, adminPass } = req.body;
    
    if (cookie) {
        try {
            const info = await service115.getUserInfo(cookie);
            globalSettings.cookie = cookie;
            globalSettings.userName = info.name;
        } catch (e) {
            return res.status(400).json({ success: false, msg: "Cookie无效: " + e.message });
        }
    }
    
    if (rootCid !== undefined) globalSettings.rootCid = rootCid;
    if (rootName !== undefined) globalSettings.rootName = rootName;
    if (adminUser) globalSettings.adminUser = adminUser;
    if (adminPass) globalSettings.adminPass = adminPass;
    
    saveSettings();
    res.json({ success: true, msg: "设置已保存", data: globalSettings });
});

// 4. 获取目录 (公开，方便朋友选择子目录，默认从配置的根目录开始)
app.get('/api/folders', async (req, res) => {
    if (!globalSettings.cookie) return res.status(400).json({ success: false, msg: "管理员未配置Cookie" });
    
    // 默认使用管理员设置的根目录，如果没有传 cid
    const targetCid = req.query.cid || globalSettings.rootCid || "0";
    
    try {
        const data = await service115.getFolderList(globalSettings.cookie, targetCid);
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ success: false, msg: "获取目录失败: " + e.message });
    }
});

// 5. 获取任务列表 (公开)
app.get('/api/tasks', (req, res) => {
    // 隐藏敏感信息
    const safeTasks = globalTasks.map(t => ({
        ...t, shareCode: undefined, receiveCode: undefined
    }));
    res.json(safeTasks);
});

// 6. 添加任务 (公开)
app.post('/api/task', async (req, res) => {
    const { taskName, shareUrl, password, targetCid, targetName, cronExpression } = req.body;
    
    if (!globalSettings.cookie) return res.status(400).json({ success: false, msg: "系统未配置 Cookie" });
    const cookie = globalSettings.cookie;

    try {
        const urlInfo = extractShareCode(shareUrl);
        const pass = password || urlInfo.password;

        const shareInfo = await service115.getShareInfo(cookie, urlInfo.code, pass);

        let finalTaskName = taskName;
        if (!finalTaskName || finalTaskName.trim() === "") {
            finalTaskName = shareInfo.shareTitle; 
        }
        
        // 默认使用管理员配置的根目录
        let finalTargetCid = targetCid || globalSettings.rootCid || "0";
        let finalTargetName = targetName || globalSettings.rootName || "根目录";

        const newTask = {
            id: Date.now(),
            taskName: finalTaskName,
            shareUrl: shareUrl,
            shareCode: urlInfo.code,
            receiveCode: pass,
            targetCid: finalTargetCid,
            targetName: finalTargetName,
            cronExpression: cronExpression,
            status: 'pending',
            log: '任务已初始化',
            lastShareHash: shareInfo.fileIds.join(','), // 首次运行时计算哈希
            lastSuccessDate: null, 
            lastSavedFileIds: [],
            historyCount: 0,
            createTime: Date.now(),
        };

        globalTasks.unshift(newTask);
        saveTasks();

        processTask(newTask, false);

        if (cronExpression && cronExpression.trim().length > 0) {
            startCronJob(newTask);
        }
        res.json({ success: true, msg: "任务创建成功" });

    } catch (e) {
        console.error(e);
        res.status(400).json({ success: false, msg: e.message });
    }
});

// 7. 编辑任务 (公开)
app.put('/api/task/:id', async (req, res) => {
    const taskId = parseInt(req.params.id);
    const { taskName, shareUrl, password, targetCid, targetName, cronExpression } = req.body;
    
    const task = globalTasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ success: false, msg: "任务不存在" });
    
    if (cronJobs[taskId]) {
        cronJobs[taskId].stop();
    }

    try {
        // 更新字段
        if (taskName) task.taskName = taskName;
        if (targetCid) task.targetCid = targetCid;
        if (targetName) task.targetName = targetName;
        
        // 如果更新了链接，重新解析 shareCode/receiveCode
        if (shareUrl && shareUrl !== task.shareUrl) {
            const urlInfo = extractShareCode(shareUrl);
            task.shareUrl = shareUrl;
            task.shareCode = urlInfo.code;
            task.receiveCode = password || urlInfo.password;
            task.lastShareHash = null; // 链接变了，重置哈希
        } else if (password) {
            task.receiveCode = password; // 只更新了密码
        } else if (shareUrl) {
            task.shareUrl = shareUrl; // 确保 URL 也是最新的 (即使内容不变)
        }

        // 更新定时策略
        task.cronExpression = cronExpression;

        // 如果有新的有效 Cron，重新启动定时器
        if (cronExpression && cronExpression.trim() !== "" && cron.validate(cronExpression)) {
            task.status = 'scheduled';
            startCronJob(task);
        } else {
            // 【修正】当定时器关闭时，状态为 pending，日志提示等待手动执行
            task.status = 'pending';
            task.log = '▶️ 定时已关闭，等待手动执行';
        }

        saveTasks();
        res.json({ success: true, msg: "任务已更新" });

    } catch (e) {
        res.status(400).json({ success: false, msg: "更新失败: " + e.message });
    }
});

// 8. 删除任务 (公开)
app.delete('/api/task/:id', (req, res) => {
    const taskId = parseInt(req.params.id);
    
    if (cronJobs[taskId]) {
        cronJobs[taskId].stop();
        delete cronJobs[taskId];
    }
    globalTasks = globalTasks.filter(t => t.id !== taskId);
    saveTasks();
    res.json({ success: true });
});

// 9. 手动执行 (公开)
app.put('/api/task/:id/run', (req, res) => {
    const taskId = parseInt(req.params.id);
    const task = globalTasks.find(t => t.id === taskId);
    
    if (!task) return res.status(404).json({ success: false, msg: "任务不存在" });
    
    // 手动执行时不进行 "当日成功锁定" 检查 (isCron=false)
    // 强制执行时，应将任务状态切换为 running
    updateTaskStatus(task, 'running', `[${formatTime()}] 收到手动执行指令，开始运行...`);
    
    // 使用 setTimeout 确保 API 响应能快速返回，任务在后台异步执行
    setTimeout(() => {
        processTask(task, false); 
    }, 100); 

    res.json({ success: true, msg: "任务已启动" });
});

// --- 内部功能函数 ---

function startCronJob(task) {
    if (cronJobs[task.id]) {
        cronJobs[task.id].stop();
        delete cronJobs[task.id];
    }

    if (!task.cronExpression || !cron.validate(task.cronExpression)) {
        return;
    }

    console.log(`[Cron] 启动/重启任务 ${task.taskName}: ${task.cronExpression}`);
    
    cronJobs[task.id] = cron.schedule(task.cronExpression, () => {
        processTask(task, true);
    });
}

// 【核心监控逻辑】
async function processTask(task, isCron = false) {
    if (!globalSettings.cookie) {
        updateTaskStatus(task, isCron ? 'scheduled' : 'error', `[${formatTime()}] Cookie配置缺失或失效`);
        return;
    }
    const cookie = globalSettings.cookie;
    const todayStr = new Date().toISOString().split('T')[0];

    // --- 1. 每日成功锁定检查 ---
    // 【R2-修改】后续 Cron 任务才检查，手动任务不检查
    if (isCron && task.status === 'scheduled' && task.lastSuccessDate === todayStr) {
        console.log(`[Cron Skip] 任务 ${task.id} (${task.taskName}) 今日已成功执行，跳过`);
        updateTaskStatus(task, 'scheduled', `[${formatTime()}] 今日已成功转存，跳过本次执行`);
        return; 
    }
    
    updateTaskStatus(task, 'running', `[${formatTime()}] 正在检查更新...`);
    
    // --- 2. 检查分享内容更新 (通过哈希文件列表) ---
    try {
        // 注意：此处已移除自动创建文件夹的逻辑。转存将直接在 targetCid 下进行。
        let shareInfo = await service115.getShareInfo(cookie, task.shareCode, task.receiveCode);
        
        // 【新增】智能穿透：如果分享链接里只有一个文件夹，则自动提取其内容
        if (shareInfo.list && shareInfo.list.length === 1) {
            const item = shareInfo.list[0];
            // 115 API 特征：文件夹有 cid 但通常没有 fid (在 snap 接口中)
            if (item.cid && !item.fid) {
                console.log(`[Task] 🔍 检测到单文件夹 [${item.n}]，正在穿透提取内容...`);
                try {
                    const innerInfo = await service115.getShareInfo(cookie, task.shareCode, task.receiveCode, item.cid);
                    // 只有当内部有文件时才替换，防止空文件夹导致异常
                    if (innerInfo.fileIds.length > 0) {
                        shareInfo = innerInfo;
                    }
                } catch (e) {
                    console.warn(`[Task] 尝试进入文件夹失败，将按原样转存: ${e.message}`);
                }
            }
        }

        const fileIds = shareInfo.fileIds;
        
        if (!fileIds || fileIds.length === 0) {
            const finalStatus = isCron ? 'scheduled' : 'failed';
            updateTaskStatus(task, finalStatus, `[${formatTime()}] 分享链接内无文件`);
            return; 
        }

        const currentShareHash = fileIds.join(',');

        // 【R2-修改】如果是 Cron 任务，且内容无变化，则跳过转存
        if (isCron && task.lastShareHash && task.lastShareHash === currentShareHash) {
            console.log(`[Skip] 任务 ${task.id} (${task.taskName}) 内容无更新，跳过转存`);
            updateTaskStatus(task, 'scheduled', `[${formatTime()}] 内容无更新，跳过转存`);
            return; 
        }
        
        // 首次运行或内容已更新，记录新哈希值（用于下次对比）
        task.lastShareHash = currentShareHash; 
        
        // --- 2.5 清理旧版本文件 (关键修改) ---
        if (task.lastSavedFileIds && task.lastSavedFileIds.length > 0) {
            console.log(`[Task] 正在清理旧版本文件: ${task.lastSavedFileIds.length} 个`);
            // 尝试删除，即使失败（例如已被手动删除）也不阻断后续流程
            await service115.deleteFiles(cookie, task.lastSavedFileIds);
        }

        // --- 3. 执行转存 ---
        const saveResult = await service115.saveFiles(cookie, task.targetCid, task.shareCode, task.receiveCode, fileIds);

       // --- 4. 成功后更新状态和日期 ---
        if (saveResult.success) {
            const finalStatus = isCron ? 'scheduled' : 'success';
            // 【新增】成功后记录日期
            task.lastSuccessDate = todayStr;
            
            // 【新增】获取刚刚保存的文件ID，存入 task 以便下次删除
            // 假设按时间排序，最新的 N 个文件即为本次转存的文件
            const recent = await service115.getRecentItems(cookie, task.targetCid, saveResult.count);
            if (recent.success) {
                task.lastSavedFileIds = recent.items;
            }

            const logMsg = saveResult.msg || `[${formatTime()}] 成功转存 ${saveResult.count} 个文件`;
            updateTaskStatus(task, finalStatus, logMsg);
        } else if (saveResult.status === 'exists') {
            // 【新增】处理“文件已存在”的情况：检查目标文件夹是否真的有文件
            // 有时候 115 会误报，或者文件确实在别的目录。我们需要确认目标目录里有没有东西。
            const checkFiles = await service115.getRecentItems(cookie, task.targetCid, 5);
            
            if (checkFiles.success && checkFiles.items.length > 0) {
                // 目标文件夹里有文件，说明虽然提示重复，但文件确实在里面（可能是秒传成功）
                task.lastSuccessDate = todayStr;
                task.lastSavedFileIds = checkFiles.items;
                updateTaskStatus(task, isCron ? 'scheduled' : 'success', `[${formatTime()}] 转存成功 (秒传/已存在)`);
            } else {
                // 目标文件夹是空的，说明文件在别的地方（比如根目录）
                const finalStatus = isCron ? 'scheduled' : 'failed';
                updateTaskStatus(task, finalStatus, `[${formatTime()}] ⚠️ 失败: 文件已存在于网盘其他位置(请检查根目录)，无法存入新文件夹`);
            }
        } else {
            const finalStatus = isCron ? 'scheduled' : 'failed'; 
            updateTaskStatus(task, finalStatus, `转存失败: ${saveResult.msg}`);
        }

    } catch (e) {
        const finalStatus = isCron ? 'scheduled' : 'error';
        updateTaskStatus(task, finalStatus, `错误: ${e.message}`);
    }
}

function updateTaskStatus(task, status, log) {
    task.status = status;
    task.log = log;
    saveTasks();
}

function extractShareCode(url) {
    if (!url) throw new Error("链接不能为空");
    const codeMatch = url.match(/\/s\/([a-z0-9]+)/i);
    if (!codeMatch) throw new Error("无法识别链接格式");
    
    const pwdMatch = url.match(/[?&]password=([^&#]+)/);
    return { 
        code: codeMatch[1], 
        password: pwdMatch ? pwdMatch[1] : "" 
    };
}

function formatTime() {
    const d = new Date();
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
}

initSystem();
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
