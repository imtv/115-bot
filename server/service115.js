const axios = require('axios');
const qs = require('querystring');

class Service115 {
    constructor() {
        // 移除 keepAlive agent，避免长时间运行后出现 socket hang up / 网络错误
        this.headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36 MicroMessenger/6.8.0(0x16080000) NetType/WIFI MiniProgramEnv/Mac MacWechat/WMPF XWEB/30626",
            "Referer": "https://servicewechat.com/wx2c744c010a61b0fa/94/page-frame.html",
            "Accept-Encoding": "gzip, deflate, br",
            "Accept": "*/*"
        };
    }

    _getHeaders(cookie) {
        return { ...this.headers, "Cookie": cookie };
    }

    // 1. 获取用户信息
    async getUserInfo(cookie) {
        if (!cookie) throw new Error("Cookie为空");
        try {
            const res = await axios.get("https://webapi.115.com/files/index_info", {
                headers: this._getHeaders(cookie),
                timeout: 6000
            });
            if (res.data.state) {
                return { success: true, name: res.data.data?.user_name || "115用户" };
            }
            throw new Error("Cookie无效或已过期");
        } catch (e) {
            throw new Error("连接115失败: " + (e.response?.status || e.message));
        }
    }

    // 2. 获取文件夹列表
    async getFolderList(cookie, cid = "0", limit = 100) {
        try {
            const res = await axios.get("https://webapi.115.com/files", {
                headers: this._getHeaders(cookie),
                params: { aid: 1, cid: cid, o: "user_ptime", asc: 0, offset: 0, show_dir: 1, limit: Math.max(limit, 1000), type: 0, format: "json" }
            });
            if (res.data.state) {
                return {
                    success: true,
                    path: res.data.path,
                    list: res.data.data.map(i => ({
                        id: i.fid || i.cid,
                        name: i.n,
                        type: i.fid ? 'file' : 'folder',
                        cid: i.cid,
                        fid: i.fid,
                        size: i.s,
                        time: i.t
                    }))
                };
            }
            throw new Error(res.data.error || "获取目录失败");
        } catch (e) {
            throw new Error(e.message);
        }
    }

    // 3. 创建文件夹
    async addFolder(cookie, parentCid, folderName) {
        const postData = qs.stringify({
            pid: parentCid,
            cname: folderName
        });
        try {
            const res = await axios.post("https://webapi.115.com/files/add", postData, {
                headers: this._getHeaders(cookie)
            });
            
            if (res.data.state) {
                // 115 API 创建文件夹返回的是 file_id，不是 cid
                if (res.data.data) {
                    return { success: true, cid: res.data.data.file_id || res.data.data.cid, name: res.data.data.file_name };
                }
            }
            
            // 【修复】如果提示"目录名称已存在" 或者 创建成功但未返回数据，则尝试查找并返回已存在的文件夹CID
            if ((res.data.error && res.data.error.includes("已存在")) || (res.data.state && !res.data.data)) {
                // 获取父目录下较多的文件夹列表(1000个)，尝试找到同名的
                const listRes = await this.getFolderList(cookie, parentCid, 1000);
                if (listRes.success && listRes.list) {
                    const existing = listRes.list.find(f => f.name === folderName);
                    if (existing) {
                        return { success: true, cid: existing.cid, name: existing.name, msg: "文件夹已存在，自动关联" };
                    }
                }
                // 如果是创建成功但没找到，提示刷新
                if (res.data.state) {
                    throw new Error("文件夹创建成功，但在列表中暂时未找到，请稍后刷新页面查看");
                }
                throw new Error("创建失败: 115提示目录已存在，但在该目录下未找到同名文件夹(可能是同名文件导致)，请检查");
            }

            throw new Error(res.data.error || "创建文件夹失败");
        } catch (e) {
            throw new Error("创建文件夹API异常: " + e.message);
        }
    }

    // 4. 获取分享链接信息 (文件ID列表和标题)
    async getShareInfo(cookie, shareCode, receiveCode, cid = "") {
        try {
            const res = await axios.get("https://webapi.115.com/share/snap", {
                headers: this._getHeaders(cookie),
                timeout: 10000,
                params: { share_code: shareCode, receive_code: receiveCode, offset: 0, limit: 100, cid: cid }
            });
            
            if (!res.data.state) {
                throw new Error(res.data.error || res.data.msg || "链接无效或提取码错误");
            }
            
            // 【关键修改】获取文件ID列表并排序，用于 server.js 中的哈希对比
            const fileIds = res.data.data.list
                .map(item => item.cid || item.fid)
                .sort(); 
                
            return {
                success: true,
                fileIds: fileIds,
                shareTitle: res.data.data.share_title || (res.data.data.list[0] ? res.data.data.list[0].n : "未命名任务"),
                count: res.data.data.count,
                list: res.data.data.list // 返回原始列表以供类型判断
            };
        } catch (e) {
            throw new Error(e.message);
        }
    }

    // 5. 转存文件
    async saveFiles(cookie, targetCid, shareCode, receiveCode, fileIds) {
        if (!fileIds.length) return { success: true, count: 0 }; // 没有文件要转存也算成功
        
        const postData = qs.stringify({
            cid: targetCid,
            share_code: shareCode,
            receive_code: receiveCode,
            file_id: fileIds.join(',')
        });

        try {
            const res = await axios.post("https://webapi.115.com/share/receive", postData, {
                headers: this._getHeaders(cookie)
            });
            if (res.data.state) return { success: true, count: fileIds.length };
            
            // 【修改】如果提示"文件已接收"，不要直接返回成功，而是返回特殊状态
            if (res.data.error && res.data.error.includes("无需重复接收")) {
                return { success: false, status: 'exists', msg: "文件已存在(115自动去重)" };
            }

            return { success: false, msg: res.data.error || res.data.msg || "转存被拒绝" };
        } catch (e) {
            return { success: false, msg: "转存API请求失败: " + e.message };
        }
    }

    // 6. 批量删除文件 (移入回收站)
    async deleteFiles(cookie, fileIds) {
        if (!fileIds || fileIds.length === 0) return { success: true };
        
        const params = {};
        if (Array.isArray(fileIds)) {
            fileIds.forEach((id, i) => params[`fid[${i}]`] = id);
        } else {
            params['fid[0]'] = fileIds;
        }
        const postData = qs.stringify(params);

        try {
            const res = await axios.post("https://webapi.115.com/rb/delete", postData, {
                headers: this._getHeaders(cookie)
            });
            if (res.data.state) return { success: true };
            return { success: false, msg: res.data.error || "删除失败" };
        } catch (e) {
            return { success: false, msg: "删除API异常: " + e.message };
        }
    }

    // 7. 获取最近上传/转存的文件（用于记录 ID 以便下次删除）
    async getRecentItems(cookie, cid, limit = 10) {
        if (limit <= 0) return { success: true, items: [] };
        try {
            const res = await axios.get("https://webapi.115.com/files", {
                headers: this._getHeaders(cookie),
                params: { aid: 1, cid: cid, o: "user_ptime", asc: 0, offset: 0, show_dir: 1, limit: limit, type: 0, format: "json" }
            });
            if (res.data.state && res.data.data) {
                // 提取详细信息
                const items = res.data.data.map(item => ({
                    id: item.fid || item.cid,
                    isFolder: !item.fid,
                    name: item.n
                }));
                return { success: true, items };
            }
            return { success: false, items: [] };
        } catch (e) {
            return { success: false, items: [] };
        }
    }

    // 10. 重命名文件/文件夹
    async renameFile(cookie, fileId, newName) {
        const postData = qs.stringify({
            [`files_new_name[${fileId}]`]: newName
        });
        try {
            const res = await axios.post("https://webapi.115.com/files/batch_rename", postData, {
                headers: this._getHeaders(cookie)
            });
            if (res.data.state) return { success: true };
            return { success: false, msg: res.data.error || "重命名失败" };
        } catch (e) {
            return { success: false, msg: "重命名API异常: " + e.message };
        }
    }

    // 9. 获取文件夹路径信息
    async getPath(cookie, cid) {
        try {
            const res = await axios.get("https://webapi.115.com/files", {
                headers: this._getHeaders(cookie),
                params: { aid: 1, cid: cid, limit: 1, format: "json" }
            });
            if (res.data.state) {
                return { success: true, path: res.data.path || [] };
            }
            return { success: false, path: [] };
        } catch (e) {
            return { success: false, path: [] };
        }
    }
}

module.exports = new Service115();
