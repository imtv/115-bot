const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const service115 = require('./service115');

const app = express();
const PORT = 3000;

// 生产环境请修改此密钥
const JWT_SECRET = 'your_super_secret_key_115_master';

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// 1. 路径配置：使用 resolve 确保路径准确
const DATA_ROOT = path.resolve(__dirname, '../data');
const USERS_FILE = path.join(DATA_ROOT, 'users.json');

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

// 缓存变量
let tasksCache = {};
let cronJobs = {};

// 获取用户目录（如果不存在则创建）
const getUserDir = (uid) => {
    const dir = path.join(DATA_ROOT, String(uid));
    if (!fs.existsSync(dir)) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`[System] 为用户 ${uid} 创建了数据文件夹`);
        } catch (e) {
            console.error(`[System] 创建用户目录失败: ${e.message}`);
        }
    }
    return dir;
};

// 初始化：恢复之前的 Cron 任务
function initSystem() {
    if (fs.existsSync(USERS_FILE)) {
        try {
            const users = JSON.parse(fs.readFileSync(USERS_FILE));
            console.log(`[System] 发现 ${users.length} 个注册用户`);
            
            users.forEach(u => {
                const taskFile = path.join(getUserDir(u.id), 'tasks.json');
                if (fs.existsSync(taskFile)) {
                    const tasks = JSON.parse(fs.readFileSync(taskFile));
                    tasksCache[u.id] = tasks;
                    
                    let count = 0;
                    tasks.forEach(t => {
                        // 恢复状态不是 stopped 且有 cron 表达式的任务
                        if (t.cronExpression && t.status !== 'stopped') {
                            startCronJob(u.id, t);
                            count++;
                        }
                    });
                    if(count > 0) console.log(` - 用户 [${u.username}] 恢复了 ${count} 个定时任务`);
                }
            });
        } catch (e) {
            console.error("[System] 初始化数据读取失败:", e);
        }
    }
}

// 中间件：JWT 验证
const authenticate = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, msg: "未登录" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, msg: "Token 无效" });
        req.user = user;
        next();
    });
};

// --- Auth API ---

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, msg: "缺少参数" });
    
    let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : [];
    if (users.find(u => u.username === username)) {
        return res.status(400).json({ success: false, msg: "用户名已存在" });
    }
    
    const newUser = { id: Date.now(), username, password };
    users.push(newUser);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    getUserDir(newUser.id); // 初始化目录
    
    res.json({ success: true, msg: "注册成功" });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : [];
    const user = users.find(u => u.username === username && u.password === password);
    
    if (user) {
        // 登录成功时，确保该用户的目录存在 (修复数据丢失的错觉)
        getUserDir(user.id);
        
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, username: user.username });
    } else {
        res.status(401).json({ success: false, msg: "用户名或密码错误" });
    }
});

// --- Config API ---

app.get('/api/config', authenticate, (req, res) => {
    const configFile = path.join(getUserDir(req.user.id), 'config.json');
    if (fs.existsSync(configFile)) {
        res.json(JSON.parse(fs.readFileSync(configFile)));
    } else {
        res.json({ cookie: "" });
    }
});

app.post('/api/config', authenticate, async (req, res) => {
    const { cookie } = req.body;
    try {
        const info = await service115.getUserInfo(cookie);
        const configFile = path.join(getUserDir(req.user.id), 'config.json');
        fs.writeFileSync(configFile, JSON.stringify({ cookie, name: info.name }, null, 2));
        res.json({ success: true, name: info.name });
    } catch (e) {
        res.status(400).json({ success: false, msg: e.message });
    }
});

app.get('/api/folders', authenticate, async (req, res) => {
    const configFile = path.join(getUserDir(req.user.id), 'config.json');
    if (!fs.existsSync(configFile)) return res.status(400).json({ success: false, msg: "请先配置 Cookie" });
    const { cookie } = JSON.parse(fs.readFileSync(configFile));
    
    try {
        const data = await service115.getFolderList(cookie, req.query.cid || "0");
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ success: false, msg: "获取目录失败: " + e.message });
    }
});

// --- Task API ---

app.get('/api/tasks', authenticate, (req, res) => {
    if (!tasksCache[req.user.id]) {
        const taskFile = path.join(getUserDir(req.user.id), 'tasks.json');
        if (fs.existsSync(taskFile)) {
            tasksCache[req.user.id] = JSON.parse(fs.readFileSync(taskFile));
        } else {
            tasksCache[req.user.id] = [];
        }
    }
    res.json(tasksCache[req.user.id]);
});

app.post('/api/task', authenticate, async (req, res) => {
    // cronExpression 现在直接接收字符串，例如 "* * * * *" 或 ""
    const { taskName, shareUrl, password, targetCid, targetName, cronExpression } = req.body;
    const userId = req.user.id;

    const configFile = path.join(getUserDir(userId), 'config.json');
    if (!fs.existsSync(configFile)) return res.status(400).json({ success: false, msg: "未配置 Cookie" });
    const { cookie } = JSON.parse(fs.readFileSync(configFile));

    try {
        const urlInfo = extractShareCode(shareUrl);
        const pass = password || urlInfo.password;

        // --- 核心新功能：自动归档逻辑 ---
        // 1. 先获取分享链接的信息 (主要是标题)
        const shareData = await service115.getShareSnap(cookie, urlInfo.code, pass);
        
        // 2. 决定最终的任务名和目标目录
        let finalTaskName = taskName;
        let finalTargetCid = targetCid || "0";
        let finalTargetName = targetName || "根目录";

        // 如果用户没有填任务名，我们认为是"自动模式"
        if (!finalTaskName || finalTaskName.trim() === "") {
            finalTaskName = shareData.shareTitle; // 使用分享的标题作为任务名
            console.log(`[AutoFolder] 自动命名任务: ${finalTaskName}`);
            
            // 尝试在目标目录下创建同名文件夹
            try {
                const newFolder = await service115.addFolder(cookie, finalTargetCid, finalTaskName);
                if (newFolder.success) {
                    finalTargetCid = newFolder.cid;
                    finalTargetName = `${finalTargetName} > ${newFolder.name}`;
                    console.log(`[AutoFolder] 自动创建并切换目录至: ${finalTargetName}`);
                }
            } catch (err) {
                console.warn(`[AutoFolder] 创建文件夹失败 (${err.message})，将存入原目录`);
            }
        }

        // 3. 创建任务对象
        const newTask = {
            id: Date.now(),
            taskName: finalTaskName,
            shareUrl: shareUrl, // 保存原始 URL 用于前端跳转
            shareCode: urlInfo.code,
            receiveCode: pass,
            targetCid: finalTargetCid,
            targetName: finalTargetName,
            cronExpression: cronExpression, // 只有当字符串不为空时才会被 Cron 执行
            status: 'pending',
            log: '任务已初始化',
            historyCount: 0,
            createTime: Date.now(),
            lastSuccessDate: null
        };

        // 4. 保存并执行
        if (!tasksCache[userId]) tasksCache[userId] = [];
        tasksCache[userId].unshift(newTask);
        saveUserTasks(userId);

        // 立即执行一次 (无论是单次任务还是定时任务，刚创建都应该跑一次)
        processTask(userId, newTask, false, true);

        // 如果有 cron 表达式，加入调度器
        if (cronExpression && cronExpression.trim().length > 0) {
            newTask.status = 'scheduled';
            startCronJob(userId, newTask);
            saveUserTasks(userId);
        }

        res.json({ success: true, msg: "任务创建成功" });

    } catch (e) {
        console.error(e);
        res.status(400).json({ success: false, msg: e.message });
    }
});

app.put('/api/task/:id', authenticate, async (req, res) => {
    const userId = req.user.id;
    const taskId = parseInt(req.params.id);
    const { taskName, shareUrl, password, targetCid, targetName, cronExpression } = req.body;
    
    // 1. 查找任务
    const userTasks = tasksCache[userId] || [];
    const task = userTasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ success: false, msg: "任务不存在" });
    
    // 2. 停止旧的定时器（如果有）
    if (cronJobs[taskId]) {
        cronJobs[taskId].stop();
        delete cronJobs[taskId];
    }

    try {
        // 3. 更新字段
        if (taskName) task.taskName = taskName;
        if (targetCid) task.targetCid = targetCid;
        if (targetName) task.targetName = targetName;
        
        // 如果更新了链接，重新解析
        if (shareUrl && shareUrl !== task.shareUrl) {
            const urlInfo = extractShareCode(shareUrl);
            task.shareUrl = shareUrl;
            task.shareCode = urlInfo.code;
            // 如果 URL 里自带密码，优先用 URL 的；如果用户填了新密码，用填的
            task.receiveCode = password || urlInfo.password || task.receiveCode;
        } else if (password) {
            // 只更新了密码
            task.receiveCode = password;
        }

        // 4. 更新定时策略
        task.cronExpression = cronExpression; // 更新表达式

        // 5. 如果有新的有效 Cron，重新启动定时器
        if (cronExpression && cronExpression.trim() !== "" && cron.validate(cronExpression)) {
            task.status = 'scheduled';
            console.log(`[Cron] 更新并重启任务 ${task.id}: ${cronExpression}`);
            cronJobs[task.id] = cron.schedule(cronExpression, () => {
                processTask(userId, task, true);
            });
        } else {
            // 如果清空了 Cron，状态改为 pending
            task.status = 'pending';
            task.log = '定时已关闭，等待手动执行';
        }

        saveUserTasks(userId);
        res.json({ success: true, msg: "任务已更新" });

    } catch (e) {
        console.error(e);
        res.status(400).json({ success: false, msg: "更新失败: " + e.message });
    }
});

app.delete('/api/task/:id', authenticate, (req, res) => {
    const userId = req.user.id;
    const taskId = parseInt(req.params.id);
    
    // 停止定时器
    if (cronJobs[taskId]) {
        cronJobs[taskId].stop();
        delete cronJobs[taskId];
    }
    
    // 删除数据
    if (tasksCache[userId]) {
        tasksCache[userId] = tasksCache[userId].filter(t => t.id !== taskId);
        saveUserTasks(userId);
    }
    res.json({ success: true });
});

// --- 内部功能函数 ---

function startCronJob(userId, task) {
    if (cronJobs[task.id]) {
        cronJobs[task.id].stop();
        delete cronJobs[task.id];
    }

    if (!task.cronExpression || !cron.validate(task.cronExpression)) {
        console.log(`[Cron] 任务 ${task.id} 无效的表达式: ${task.cronExpression}`);
        return;
    }

    console.log(`[Cron] 启动任务 ${task.taskName}: ${task.cronExpression}`);
    
    cronJobs[task.id] = cron.schedule(task.cronExpression, () => {
        processTask(userId, task, true);
    });
}

async function processTask(userId, task, isCron = false, force = false) {
    const configFile = path.join(getUserDir(userId), 'config.json');
    if (!fs.existsSync(configFile)) return; // 没配置 cookie 就不跑了
    const { cookie } = JSON.parse(fs.readFileSync(configFile));

    // Cron 模式下：如果今天已经成功过，跳过 (每日去重)
    // 如果你希望某些任务一天跑多次，可以把这段逻辑注释掉，或者仅针对特定 Cron 做限制
    if (isCron && task.lastSuccessDate) {
        const today = new Date().toISOString().split('T')[0];
        // 只有当 cron 包含 "日" 级别的设定时，才执行每日一次检查
        // 这里简化逻辑：所有 Cron 任务每天只记录一次成功日期，但这会阻止一天多次运行
        // 修改策略：这里暂时移除“一天一次”的硬性限制，依靠下面的“文件列表去重”来决定是否执行
    }

    if (!isCron) updateTaskStatus(userId, task, 'running', '正在解析链接...');

    try {
        // 1. 获取分享文件列表
        const snap = await service115.getShareSnap(cookie, task.shareCode, task.receiveCode);
        const fileIds = snap.list;

        if (!fileIds || fileIds.length === 0) {
            throw new Error("分享链接中没有文件");
        }

        // 2. 去重逻辑 (Cron 模式且非强制执行时)
        let filesToSave = fileIds;
        if (isCron && !force) {
            const historyFile = path.join(getUserDir(userId), 'history.json');
            const history = fs.existsSync(historyFile) ? new Set(JSON.parse(fs.readFileSync(historyFile))) : new Set();
            
            filesToSave = fileIds.filter(fid => !history.has(fid));
            
            if (filesToSave.length === 0) {
                updateTaskStatus(userId, task, 'scheduled', `[${formatTime()}] 监控正常: 无新文件`);
                return;
            }
        }

        // 3. 执行转存
        if (!isCron) updateTaskStatus(userId, task, 'running', `正在转存 ${filesToSave.length} 个文件...`);
        const result = await service115.saveFiles(cookie, task.targetCid, task.shareCode, task.receiveCode, filesToSave);

        if (result.success) {
            // 4. 记录历史
            const historyFile = path.join(getUserDir(userId), 'history.json');
            const history = fs.existsSync(historyFile) ? new Set(JSON.parse(fs.readFileSync(historyFile))) : new Set();
            filesToSave.forEach(fid => history.add(fid));
            fs.writeFileSync(historyFile, JSON.stringify([...history]));

            task.historyCount = (task.historyCount || 0) + filesToSave.length;
            if (isCron) task.lastSuccessDate = new Date().toISOString().split('T')[0];

            const status = isCron ? 'scheduled' : 'success';
            updateTaskStatus(userId, task, status, `[${formatTime()}] 成功转存 ${filesToSave.length} 个文件`);
        } else {
            const status = isCron ? 'scheduled' : 'failed'; // Cron 失败不标红，继续等待下次
            updateTaskStatus(userId, task, status, `转存失败: ${result.msg}`);
        }

    } catch (e) {
        const status = isCron ? 'scheduled' : 'error';
        updateTaskStatus(userId, task, status, `错误: ${e.message}`);
    }
}

function updateTaskStatus(userId, task, status, log) {
    task.status = status;
    task.log = log;
    // 更新内存缓存
    if (tasksCache[userId]) {
        const t = tasksCache[userId].find(i => i.id === task.id);
        if (t) {
            t.status = status;
            t.log = log;
            t.historyCount = task.historyCount;
        }
    }
    saveUserTasks(userId);
}

function saveUserTasks(userId) {
    const file = path.join(getUserDir(userId), 'tasks.json');
    try { 
        fs.writeFileSync(file, JSON.stringify(tasksCache[userId] || [], null, 2)); 
    } catch (e) { 
        console.error("保存任务失败:", e); 
    }
}

function extractShareCode(url) {
    if (!url) throw new Error("链接不能为空");
    // 支持 https://115.com/s/sw33a... 和包含 ?password= 的格式
    const codeMatch = url.match(/\/s\/([a-z0-9]+)/);
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