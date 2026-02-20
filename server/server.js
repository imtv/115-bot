const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const service115 = require('./service115');
const axios = require('axios');

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
let globalSettings = { 
    cookie: "", rootCid: "0", rootName: "根目录", 
    adminUser: "admin", adminPass: "admin",
    olUrl: "", // OpenList 地址
    olToken: "", // OpenList 密码/Token
    olMountPrefix: "" // OpenList侧挂载前缀 (如 /115网盘)
};
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
    const { cookie, rootCid, rootName, adminUser, adminPass, olUrl, olToken, olMountPrefix } = req.body;
    
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
    if (olUrl !== undefined) globalSettings.olUrl = olUrl;
    if (olToken !== undefined) globalSettings.olToken = olToken;
    if (olMountPrefix !== undefined) globalSettings.olMountPrefix = olMountPrefix;
    
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
        res.json({ success: true, data, rootCid: globalSettings.rootCid }); // 返回 rootCid 供前端判断边界
    } catch (e) {
        res.status(500).json({ success: false, msg: "获取目录失败: " + e.message });
    }
});

// 10. 创建文件夹 (公开，用于选择目录时新建)
app.post('/api/folder', async (req, res) => {
    const { parentCid, folderName } = req.body;
    if (!globalSettings.cookie) return res.status(400).json({ success: false, msg: "系统未配置 Cookie" });
    
    try {
        const result = await service115.addFolder(globalSettings.cookie, parentCid, folderName);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

// 11. 批量删除文件 (公开)
app.post('/api/files/delete', async (req, res) => {
    const { fileIds } = req.body;
    if (!globalSettings.cookie) return res.status(400).json({ success: false, msg: "系统未配置 Cookie" });
    
    try {
        const result = await service115.deleteFiles(globalSettings.cookie, fileIds);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
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

// 13. 手动触发 OpenList 索引 (公开)
app.post('/api/task/:id/refresh-index', async (req, res) => {
    const taskId = parseInt(req.params.id);
    const task = globalTasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ success: false, msg: "任务不存在" });

    try {
        const result = await refreshOpenList(task.targetCid);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
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

            let logMsg = saveResult.msg || `[${formatTime()}] 成功转存 ${saveResult.count} 个文件`;
            
            // 【修改】转存成功后，触发 OpenList 索引并将结果写入日志
            try {
                const olRes = await refreshOpenList(task.targetCid);
                logMsg += ` [索引: ${olRes.success ? '已发送' : '失败'}]`;
            } catch (e) {
                logMsg += ` [索引失败]`;
            }
            
            updateTaskStatus(task, finalStatus, logMsg);

        } else if (saveResult.status === 'exists') {
            // 【新增】处理“文件已存在”的情况：检查目标文件夹是否真的有文件
            // 有时候 115 会误报，或者文件确实在别的目录。我们需要确认目标目录里有没有东西。
            const checkFiles = await service115.getRecentItems(cookie, task.targetCid, 5);
            
            if (checkFiles.success && checkFiles.items.length > 0) {
                // 目标文件夹里有文件，说明虽然提示重复，但文件确实在里面（可能是秒传成功）
                task.lastSuccessDate = todayStr;
                task.lastSavedFileIds = checkFiles.items;
                
                let logMsg = `[${formatTime()}] 转存成功 (秒传/已存在)`;
                // 【修改】即使是秒传，也触发一次索引并将结果写入日志
                try {
                    const olRes = await refreshOpenList(task.targetCid);
                    logMsg += ` [索引: ${olRes.success ? '已发送' : '失败'}]`;
                } catch (e) {
                    logMsg += ` [索引失败]`;
                }
                
                updateTaskStatus(task, isCron ? 'scheduled' : 'success', logMsg);

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

// 【新增】OpenList 索引刷新逻辑
async function refreshOpenList(cid) {
    if (!globalSettings.olUrl) return { success: false, msg: "未配置 OpenList" };

    // 1. 获取 115 完整路径
    const pathRes = await service115.getPath(globalSettings.cookie, cid);
    if (!pathRes.success) throw new Error("无法获取115文件夹路径");

    // 构造路径字符串: /videos-115/影集/生命树
    let fullPath115 = "/" + pathRes.path.map(p => p.name).join("/");
    
    // 2. 自动获取根目录路径作为前缀
    let rootPath115 = "";
    if (globalSettings.rootCid !== "0") {
        const rootPathRes = await service115.getPath(globalSettings.cookie, globalSettings.rootCid);
        if (rootPathRes.success) {
            rootPath115 = "/" + rootPathRes.path.map(p => p.name).join("/");
        }
    }

    // 3. 路径映射
    let finalPath = fullPath115;
    // 如果配置了挂载点，且当前路径确实在根目录下
    if (globalSettings.olMountPrefix && fullPath115.startsWith(rootPath115)) {
        // 将 115根目录路径 替换为 OpenList挂载路径
        finalPath = fullPath115.replace(rootPath115, globalSettings.olMountPrefix);
    }

    console.log(`[OpenList] 准备刷新路径: ${finalPath} (原路径: ${fullPath115})`);

    // 3. 调用 OpenList 接口
    // 假设 OpenList 接口为 POST /api/refresh，参数为 path
    // 如果是其他接口格式，需根据实际情况调整
    try {
        let baseUrl = globalSettings.olUrl.replace(/\/$/, "");
        
        // 【新增】Token 容错处理：去除空格，去除可能的 "Bearer " 前缀
        let token = (globalSettings.olToken || "").trim();
        if (token.toLowerCase().startsWith("bearer ")) {
            token = token.substring(7).trim();
        }

        let strategies = [];

        // 如果用户填写的地址包含 /api/，则只尝试用户填写的
        if (baseUrl.includes('/api/')) {
            // 简单适配 update 接口参数
            if (baseUrl.endsWith('/index/update')) {
                strategies.push({ url: baseUrl, body: { paths: [finalPath] } });
            } else {
                strategies.push({ url: baseUrl, body: { path: finalPath } });
            }
        } else {
            // 自动尝试多种常见接口
            strategies = [
                // 0. 用户指定的新接口 (OpenList) - 优先级最高
                { url: baseUrl + "/api/admin/index/update", body: { paths: [finalPath] } },
                // 1. 标准管理接口 (AList v3 / OpenList)
                { url: baseUrl + "/api/admin/refresh", body: { path: finalPath } },
                // 2. 兼容接口 (旧版)
                { url: baseUrl + "/api/refresh", body: { path: finalPath } },
                // 3. 浏览接口 (强制刷新) - 最强兼容性方案
                { url: baseUrl + "/api/fs/list", body: { path: finalPath, refresh: true, page: 1, per_page: 1 } }
            ];
        }
        
        let lastError = null;

        for (const strategy of strategies) {
            try {
                console.log(`[OpenList] 尝试请求: ${strategy.url}`);
                const res = await axios.post(strategy.url, strategy.body, {
                    headers: {
                        "Authorization": token,
                        "Content-Type": "application/json"
                    },
                    timeout: 10000 // 增加超时时间，因为刷新可能较慢
                });

                // 检查返回是否为 HTML (网页代码)
                if (typeof res.data === 'string' && res.data.trim().startsWith('<')) {
                    const titleMatch = res.data.match(/<title>(.*?)<\/title>/i);
                    const pageTitle = titleMatch ? titleMatch[1] : "未知网页";
                    throw new Error(`接口返回了网页 (标题: ${pageTitle})`);
                }
                
                // 检查业务状态码 (AList通常返回 code: 200)
                if (res.data.code !== undefined && res.data.code !== 200) {
                     let msg = `API业务错误: ${res.data.message || '未知'} (Code: ${res.data.code})`;
                     if (res.data.code === 401) msg += " [请检查后台设置的Token是否正确]";
                     
                     // 【新增】OpenList 特有错误：搜索未开启
                     // 如果遇到这个错误，说明找对了接口但功能没开，应立即停止重试并报错
                     if (res.data.code === 404 && res.data.message && res.data.message.includes("search not available")) {
                         msg += " [请在 OpenList 后台开启搜索索引功能]";
                         throw new Error("CRITICAL_OPENLIST_ERROR: " + msg);
                     }

                     throw new Error(msg);
                }

                console.log(`[OpenList] 成功! 使用接口: ${strategy.url}`);
                return { success: true, msg: "索引请求已发送", data: res.data };
            } catch (e) {
                console.warn(`[OpenList] 请求 ${strategy.url} 失败: ${e.message}`);
                if (e.message.startsWith("CRITICAL_OPENLIST_ERROR:")) {
                    throw new Error(e.message.replace("CRITICAL_OPENLIST_ERROR: ", ""));
                }
                lastError = e;
            }
        }

        throw new Error(`所有尝试均失败。最后一次错误: ${lastError ? lastError.message : "未知"}`);
    } catch (e) {
        throw new Error(`OpenList请求失败: ${e.message}`);
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
