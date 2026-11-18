import fs from 'node:fs';
import path from 'node:path';

// A path supplied by an HTTP caller is never a filesystem path. Only a single
// validated media filename may be appended to one of these fixed directories.
export class AppPaths {
  constructor(root) {
    this.root = fs.realpathSync(root);
    for (const dir of ['data', 'data/emoji', 'data/audio', 'data/exports']) this.ensureDir(dir);
  }
  resolve(relative) {
    const target = path.resolve(this.root, relative);
    if (target !== this.root && !target.startsWith(this.root + path.sep)) throw new Error('路径必须位于软件目录内');
    const parts = path.relative(this.root, target).split(path.sep).filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (stat?.isSymbolicLink()) throw new Error('软件数据目录不允许符号链接或目录联接');
      if (stat?.isFile() && stat.nlink > 1) throw new Error('软件数据文件不允许硬链接');
    }
    return target;
  }
  ensureDir(relative) { fs.mkdirSync(this.resolve(relative), { recursive: true }); }
  writeJson(relative, data) {
    const target = this.resolve(relative);
    const tmp = this.resolve(relative + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  }
  mediaPath(kind, name) {
    if (!['emoji', 'audio'].includes(kind) || typeof name !== 'string' || name.length > 120 || !/^[\p{L}\p{N}_ .()\-]+$/u.test(name) || name.startsWith('.') || name.endsWith('.') || /[. ]$/.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) throw new Error('文件名不合法，请使用中英文、数字或短横线');
    const ext = path.extname(name).toLowerCase();
    if (!(kind === 'emoji' ? ['.png', '.jpg', '.jpeg', '.gif', '.webp'] : ['.mp3', '.wav', '.ogg', '.opus', '.aac', '.flac']).includes(ext)) throw new Error('不支持的媒体格式');
    return this.resolve(`data/${kind}/${name}`);
  }
}
