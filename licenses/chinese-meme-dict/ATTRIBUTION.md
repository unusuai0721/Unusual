# 署名 / Attribution

本词库采用 **CC BY 4.0**（Creative Commons Attribution 4.0 International）释出。

**你可以：** 免费使用、复制、修改、分发、商用、闭源集成。
**你唯一要做的：** 保留下面这段署名。

---

## 作者

| 角色 | 姓名 |
|---|---|
| **出品 / 出力** | **sky** |
| **Token 赞助** | **楠** |

## 复用时请复制这段署名

```
chinese-meme-dict — 中文网络梗词库
作者：sky（出力）、楠（出token）
来源：https://github.com/re-skylar/chinese-meme-dict
许可：CC BY 4.0
```

## 放在哪里

| 场景 | 建议位置 |
|---|---|
| 网站 / App | 关于页、致谢页、或页脚 |
| 开源项目 | README 的「致谢 / Credits」段 |
| 聊天机器人插件 | 插件 README + `/help` 输出里提一句 |
| 论文 / 报告 | 脚注或参考文献 |
| 二次分发的数据集 | 同级的 `ATTRIBUTION.md` 或数据文件的元数据字段 |

## 机器可读形式

`data/memes.json` 里已内置：

```json
{
  "license": "CC-BY-4.0",
  "attribution": {
    "authors": [
      { "name": "sky",  "role": "出品/出力" },
      { "name": "楠",   "role": "Token赞助" }
    ],
    "source": "https://github.com/re-skylar/chinese-meme-dict",
    "required_notice": "chinese-meme-dict — 作者：sky（出力）、楠（出token）— CC BY 4.0"
  }
}
```

程序读取 `attribution.required_notice` 即可自动输出合规署名。

---

## 关于数据本身

- **词条**（如「蚌埠住了」「泰裤辣」）是公共领域的语言事实，不构成受版权保护的创作。
- **释义文本**由 AI 原创撰写，未复制任何百科或网站原文，这部分是本库的版权客体，以 CC BY 4.0 授权。
- 若你发现某条释义与你的理解不符，欢迎提 PR 修正。

## 不想署名？

那请不要使用本库。CC BY 4.0 的全部义务就这一条：**署名**。
