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
    cookie: "", 
    // 5个分类的默认配置
    catTvCid: "0", catTvName: "电视剧",
    catMovieCid: "0", catMovieName: "电影",
    catVarietyCid: "0", catVarietyName: "综艺",
    catAnimeCid: "0", catAnimeName: "动漫",
    catOtherCid: "0", catOtherName: "其他",
    adminUser: "admin", adminPass: "admin",
    olUrl: "", // OpenList 地址
    olToken: "", // OpenList Token
    olMountPrefix: "", // OpenList侧挂载前缀 (如 /115网盘)
    enableCronFeature: false // 【新增】定时功能全局开关，默认关闭
};
let globalTasks = [];
let cronJobs = {};
let lastBaiduScanTime = 0;

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

// 【新增】获取公开设置 (无需管理员权限，用于前端判断UI显示)
app.get('/api/public-settings', (req, res) => {
    res.json({ success: true, enableCronFeature: !!globalSettings.enableCronFeature });
});

// 3. 保存设置 (需管理员)
app.post('/api/settings', requireAdmin, async (req, res) => {
    const { cookie, cats, adminUser, adminPass, olUrl, olToken, olMountPrefix, enableCronFeature } = req.body;
    
    if (cookie) {
        try {
            const info = await service115.getUserInfo(cookie);
            globalSettings.cookie = cookie;
            globalSettings.userName = info.name;
        } catch (e) {
            return res.status(400).json({ success: false, msg: "Cookie无效: " + e.message });
        }
    }
    
    // 更新分类配置
    if (cats) {
        Object.assign(globalSettings, cats);
    }

    if (adminUser) globalSettings.adminUser = adminUser;
    if (adminPass) globalSettings.adminPass = adminPass;
    if (olUrl !== undefined) globalSettings.olUrl = olUrl;
    if (olToken !== undefined) globalSettings.olToken = olToken;
    if (olMountPrefix !== undefined) globalSettings.olMountPrefix = olMountPrefix;
    if (enableCronFeature !== undefined) globalSettings.enableCronFeature = enableCronFeature;
    
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
    const { taskName, shareUrl, password, category, cronExpression } = req.body;
    
    if (!globalSettings.cookie) return res.status(400).json({ success: false, msg: "系统未配置 Cookie" });
    if (!taskName || taskName.trim() === "") return res.status(400).json({ success: false, msg: "任务名称不能为空" });
    const cookie = globalSettings.cookie;

    // 获取客户端 IP
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    // 如果经过了多级代理(如 Nginx + EasyTier)，x-forwarded-for 可能是 "IP1, IP2"，取第一个
    if (clientIp && clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();
    if (clientIp && clientIp.includes('::ffff:')) clientIp = clientIp.replace('::ffff:', '');

    try {
        const urlInfo = extractShareCode(shareUrl);
        const pass = password || urlInfo.password;

        const shareInfo = await service115.getShareInfo(cookie, urlInfo.code, pass);

        let finalTaskName = taskName;
        
        // 根据分类获取目标目录
        let finalTargetCid = "0";
        let finalTargetName = "根目录";
        
        // 映射分类到配置
        const catMap = {
            'tv': { cid: globalSettings.catTvCid, name: globalSettings.catTvName },
            'movie': { cid: globalSettings.catMovieCid, name: globalSettings.catMovieName },
            'variety': { cid: globalSettings.catVarietyCid, name: globalSettings.catVarietyName },
            'anime': { cid: globalSettings.catAnimeCid, name: globalSettings.catAnimeName },
            'other': { cid: globalSettings.catOtherCid, name: globalSettings.catOtherName }
        };

        if (category && catMap[category]) {
            finalTargetCid = catMap[category].cid;
            finalTargetName = catMap[category].name;
        }

        const newTask = {
            id: Date.now(),
            taskName: finalTaskName,
            shareUrl: shareUrl,
            shareCode: urlInfo.code,
            receiveCode: pass,
            category: category || 'other',
            targetCid: finalTargetCid,
            targetName: finalTargetName,
            cronExpression: cronExpression,
            creatorIp: clientIp, // 保存 IP
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
    const { taskName, shareUrl, password, cronExpression } = req.body;
    
    const task = globalTasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ success: false, msg: "任务不存在" });
    
    if (cronJobs[taskId]) {
        cronJobs[taskId].stop();
    }

    try {
        // 更新字段
        if (taskName) task.taskName = taskName;
        
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

// 13. 手动触发 OpenList 扫描 (公开)
app.post('/api/task/:id/refresh-index', async (req, res) => {
    const taskId = parseInt(req.params.id);
    const task = globalTasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ success: false, msg: "任务不存在" });

    try {
        const result = await refreshOpenList(task.targetCid);
        
        // 【修改】将手动扫描结果追加到日志中
        const time = formatTime();
        if (result.success) {
            task.log = (task.log || "") + `<br>✅ [${time}] 手动扫描: 成功`;
        } else {
            task.log = (task.log || "") + `<br>❌ [${time}] 手动扫描: 失败`;
        }
        saveTasks();

        res.json(result);
    } catch (e) {
        const time = formatTime();
        task.log = (task.log || "") + `<br>❌ [${time}] 手动扫描: 错误`;
        saveTasks();
        res.status(500).json({ success: false, msg: e.message });
    }
});

// 14. 手动触发指定路径扫描 (公开)
app.post('/api/scan/path', async (req, res) => {
    const { path } = req.body;
    if (!path) return res.status(400).json({ success: false, msg: "路径不能为空" });

    // 百度网盘扫描频率限制 (1小时)
    if (path === '/百度网盘') {
        const now = Date.now();
        const cooldown = 3600 * 1000;
        if (now - lastBaiduScanTime < cooldown) {
            const waitMin = Math.ceil((cooldown - (now - lastBaiduScanTime)) / 60000);
            return res.status(429).json({ success: false, msg: `百度网盘扫描冷却中，请等待 ${waitMin} 分钟后再试` });
        }
        lastBaiduScanTime = now;
    }

    try {
        const result = await executeOpenListScan(path);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

// 15. 清空所有任务 (需管理员)
app.delete('/api/tasks', requireAdmin, (req, res) => {
    // 停止所有定时任务
    Object.keys(cronJobs).forEach(id => {
        if (cronJobs[id]) cronJobs[id].stop();
    });
    cronJobs = {};
    globalTasks = [];
    saveTasks();
    res.json({ success: true, msg: "所有任务已清空" });
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
    
    // 【修改】初始化日志，准备分步记录
    let executionLog = `[${formatTime()}] 开始执行...`;
    updateTaskStatus(task, 'running', executionLog);
    
    // --- 2. 检查分享内容更新 (通过哈希文件列表) ---
    try {
        // 注意：此处已移除自动创建文件夹的逻辑。转存将直接在 targetCid 下进行。
        let shareInfo = await service115.getShareInfo(cookie, task.shareCode, task.receiveCode);
        
        // 【步骤1】成功读取分享链接
        executionLog += `<br>[${formatTime()}] 成功读取分享链接: ${shareInfo.shareTitle}`;
        updateTaskStatus(task, 'running', executionLog);

        const fileIds = shareInfo.fileIds;

        if (!fileIds || fileIds.length === 0) {
            const finalStatus = isCron ? 'scheduled' : 'failed';
            executionLog += `<br>[${formatTime()}] 分享链接内无文件`;
            updateTaskStatus(task, finalStatus, executionLog);
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

        // --- 2.6 智能文件夹处理 (新增) ---
        let finalTargetCid = task.targetCid;
        let createdFolderId = null;
        
        // 判断是否为单文件夹 (list长度为1 且 该项有cid)
        const isSingleFolder = shareInfo.list.length === 1 && !!shareInfo.list[0].cid;
        
        if (!isSingleFolder) {
            // 如果是散文件(或多个文件)，先创建一个文件夹
            const folderName = task.taskName;
            executionLog += `<br>[${formatTime()}] 检测到散文件，正在创建文件夹: ${folderName}`;
            updateTaskStatus(task, 'running', executionLog);
            
            try {
                const createRes = await service115.addFolder(cookie, task.targetCid, folderName);
                if (createRes.success) {
                    finalTargetCid = createRes.cid;
                    createdFolderId = createRes.cid;
                    executionLog += `<br>[${formatTime()}] 文件夹就绪 (CID: ${finalTargetCid})`;
                    updateTaskStatus(task, 'running', executionLog);
                } else {
                    throw new Error(createRes.msg);
                }
            } catch (e) {
                throw new Error("创建保存目录失败: " + e.message);
            }
        }

        // --- 3. 执行转存 ---
        const saveResult = await service115.saveFiles(cookie, finalTargetCid, task.shareCode, task.receiveCode, fileIds);

       // --- 4. 成功后更新状态和日期 ---
        if (saveResult.success) {
            const finalStatus = isCron ? 'scheduled' : 'success';
            // 【新增】成功后记录日期
            task.lastSuccessDate = todayStr;
            
            // 【步骤2】成功保存到路径
            executionLog += `<br>[${formatTime()}] 成功保存到${task.targetName}路径`;
            updateTaskStatus(task, 'running', executionLog);
            
            // 【新增】延迟 3 秒，等待 115 文件系统索引更新，防止获取不到刚存的文件
            await new Promise(resolve => setTimeout(resolve, 3000));

            if (createdFolderId) {
                // 如果是我们创建的文件夹，那么本次任务对应的“产物”就是这个文件夹
                task.lastSavedFileIds = [createdFolderId];
            } else {
                // 如果是单文件夹直接转存，逻辑不变 (获取最近转存的项)
                // 【修改】即使只存了1个，也获取前10个，确保能拿到数据，然后取第一个
                const recent = await service115.getRecentItems(cookie, task.targetCid, 10);
                
                if (recent.success && recent.items.length > 0) {
                    // 只有当本次确实只转存了 1 个文件/文件夹时，才执行自动重命名逻辑
                    // 否则无法确定要重命名哪一个
                    
                    if (saveResult.count === 1 && recent.items[0].isFolder && task.taskName) {
                        const item = recent.items[0];
                        task.lastSavedFileIds = [item.id]; // 记录最新的这个ID

                        if (item.name !== task.taskName) {
                            console.log(`[Task] 自动重命名: ${item.name} -> ${task.taskName}`);
                            
                            // 【新增】检查是否存在同名文件/文件夹，若存在则删除旧的
                            try {
                                const listRes = await service115.getFolderList(cookie, task.targetCid, 1000);
                                if (listRes.success && listRes.list) {
                                    const existing = listRes.list.find(f => f.name === task.taskName);
                                    if (existing) {
                                        console.log(`[Task] 发现同名文件/文件夹 [${existing.name}] (ID: ${existing.id})，正在删除旧文件...`);
                                        await service115.deleteFiles(cookie, [existing.id]);
                                        executionLog += `<br>[${formatTime()}] 删除旧同名文件: ${task.taskName}`;
                                        updateTaskStatus(task, 'running', executionLog);
                                        // 【修改】增加删除后的等待时间到 2 秒
                                        await new Promise(resolve => setTimeout(resolve, 2000)); 
                                    }
                                }
                            } catch (e) {
                                console.warn("[Task] 检查同名文件失败:", e);
                            }

                            await service115.renameFile(cookie, item.id, task.taskName);
                            
                            // 【步骤3】成功修改名称
                            executionLog += `<br>[${formatTime()}] 成功修改文件夹名称: ${task.taskName}`;
                            updateTaskStatus(task, 'running', executionLog);
                        }
                    } else {
                        // 如果是多个文件，或者不是文件夹，则只记录ID，不重命名
                        task.lastSavedFileIds = recent.items.slice(0, saveResult.count).map(i => i.id);
                    }
                }
            }

            // 【新增】等待 1 秒，确保文件系统就绪后再扫描
            await new Promise(resolve => setTimeout(resolve, 1000));

            // 【恢复】转存成功后，自动触发 OpenList 扫描
            try {
                const olRes = await refreshOpenList(task.targetCid);
                // 【步骤4】成功扫描
                executionLog += `<br>[${formatTime()}] 成功扫描 OpenList 生成 STRM`;
            } catch (e) {
                executionLog += `<br>[${formatTime()}] OpenList 扫描失败`;
            }
            
            updateTaskStatus(task, finalStatus, executionLog);

        } else if (saveResult.status === 'exists') {
            // 【新增】处理“文件已存在”的情况：检查目标文件夹是否真的有文件
            // 有时候 115 会误报，或者文件确实在别的目录。我们需要确认目标目录里有没有东西。
            
            let isSuccess = false;
            
            // 【修正】无论是否创建了文件夹，都要检查最终目标目录里是否有文件
            const checkFiles = await service115.getRecentItems(cookie, finalTargetCid, 5);
            
            if (checkFiles.success && checkFiles.items.length > 0) {
                isSuccess = true;
                task.lastSuccessDate = todayStr;
                // 如果是我们创建的文件夹，记录文件夹ID；否则记录文件ID
                task.lastSavedFileIds = createdFolderId ? [createdFolderId] : checkFiles.items.map(i => i.id);
            }

            if (isSuccess) {
                executionLog += `<br>[${formatTime()}] 文件已存在(秒传)`;
                updateTaskStatus(task, 'running', executionLog);
                
                // 【新增】等待 1 秒
                await new Promise(resolve => setTimeout(resolve, 1000));

                // 【恢复】触发扫描
                try {
                    const olRes = await refreshOpenList(task.targetCid);
                    executionLog += `<br>[${formatTime()}] 成功扫描 OpenList 生成 STRM`;
                } catch (e) {
                    executionLog += `<br>[${formatTime()}] OpenList 扫描失败`;
                }
                
                updateTaskStatus(task, isCron ? 'scheduled' : 'success', executionLog);

            } else {
                const finalStatus = isCron ? 'scheduled' : 'failed';
                executionLog += `<br>[${formatTime()}] ⚠️ 失败: 文件已存在于网盘其他位置(请检查根目录)，无法存入新文件夹`;
                updateTaskStatus(task, finalStatus, executionLog);
            }
        } else {
            const finalStatus = isCron ? 'scheduled' : 'failed'; 
            executionLog += `<br>[${formatTime()}] 转存失败: ${saveResult.msg}`;
            updateTaskStatus(task, finalStatus, executionLog);
        }

    } catch (e) {
        const finalStatus = isCron ? 'scheduled' : 'error';
        executionLog += `<br>[${formatTime()}] 错误: ${e.message}`;
        updateTaskStatus(task, finalStatus, executionLog);
    }
}

// 【修改】直接获取配置的 Token
async function getOpenListToken() {
    if (globalSettings.olToken && globalSettings.olToken.trim() !== "") {
        return globalSettings.olToken.trim();
    }
    throw new Error("未配置 OpenList Token");
}

// 【恢复】OpenList 扫描逻辑 (调用 /api/admin/index/update)
async function refreshOpenList(cid) {
    if (!globalSettings.olUrl) return { success: false, msg: "未配置 OpenList" };

    // 1. 获取 115 完整路径
    const pathRes = await service115.getPath(globalSettings.cookie, cid);
    if (!pathRes.success) throw new Error("无法获取115文件夹路径");

    let fullPath115 = "/" + pathRes.path.map(p => p.name).join("/");
    
    // 2. 获取根目录路径
    let rootPath115 = "";
    if (globalSettings.rootCid !== "0") {
        const rootPathRes = await service115.getPath(globalSettings.cookie, globalSettings.rootCid);
        if (rootPathRes.success) {
            rootPath115 = "/" + rootPathRes.path.map(p => p.name).join("/");
        }
    }

    // 3. 路径映射
    let finalPath = fullPath115;
    if (globalSettings.olMountPrefix && fullPath115.startsWith(rootPath115)) {
        finalPath = fullPath115.replace(rootPath115, globalSettings.olMountPrefix);
    }

    console.log(`[OpenList] 准备扫描路径: ${finalPath}`);

    return await executeOpenListScan(finalPath);
}

async function executeOpenListScan(path) {
    if (!globalSettings.olUrl) return { success: false, msg: "未配置 OpenList" };
    
    try {
        let baseUrl = globalSettings.olUrl.replace(/\/$/, "");
        let token = await getOpenListToken();

        // 【修正】使用抓包确认的“手动扫描”接口
        const url = baseUrl + "/api/admin/scan/start";
        
        const res = await axios.post(url, {
            path: path, // 抓包确认为 path 且不是数组
            limit: 0         // 抓包确认为 0
        }, {
            headers: {
                "Authorization": token, // 不带 Bearer
                "Content-Type": "application/json"
            },
            timeout: 10000
        });

        if (res.data.code !== 200) {
             if (res.data.code === 404 && res.data.message && res.data.message.includes("search not available")) {
                 throw new Error("OpenList未开启索引功能，请去后台开启！");
             }
             throw new Error(`API错误: ${res.data.message} (Code: ${res.data.code})`);
        }

        return { success: true, msg: "扫描请求已发送", data: res.data };
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
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
}

initSystem();
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
