# @yukieiji/command-permission

DSH の承認（エスカレーション）まわりに、次の2つの機能を足すプラグインです。

## 機能

### 1. 承認パネルのワンクリック許可ボタン

`pwsh` / `bash` のエスカレーション承認が出ると、コマンド文字列の下に
2列の許可ボタンが並びます（`uv run app.py` の例）:

- **セッション行**: このセッション中「uv run app.py」/「uv run \*」/「uv \*」を許可
- **ワークスペース行**: ワークスペース許可リストに「uv run app.py」/「uv run \*」/「uv \*」を追加

どちらのボタンも、クリックするとパターンを登録して現在の承認にその場で
「許可」を返します（1クリックで完了）。

- セッション許可は `.dsh/command-permissions.json` の `session` セクションに
  **セッションIDごとに保存**されます（ホスト再起動でも残る。他のセッションには影響しない）
- ワークスペース許可はそのワークスペースの全セッションに効きます

### 2. ワークスペース右クリックの許可/ブラックリスト

サイドバーのワークスペース行を**右クリック** →「コマンド権限…」で、
そのワークスペース専用のリストを編集できます。

- **許可リスト**: 一致するコマンドのエスカレーションは毎回自動で許可（聞かない）
- **ブラックリスト**: 一致するコマンドは毎回自動で拒否（聞かない・許可より優先）

## パターン意味

保存先: `<ワークスペース>/.dsh/command-permissions.json`

```json
{
  "allow": ["uv run *", "git status"],
  "deny": ["git push", "rm *"],
  "session": {
    "s0123456789abcdef": ["uv run app.py"]
  }
}
```

1行1パターン。**`*` が無ければ完全一致**、**`*` は任意位置で使えるワイルドカード**です。

| パターン | 一致する例 | しない例 |
| --- | --- | --- |
| `uv run app.py` | `uv run app.py`（完全一致のみ） | `uv run other.py` |
| `uv run *` | `uv run app.py`、`uv run anything deep.py` | `uv run`（末尾スペースが必要） |
| `uv *` | `uv add requests` | `uvx add x` |
| `* --force` | `git push --force` | `git push` |
| `git * origin` | `git push origin` | `git push` |

- 空白は正規化して比較するので `git  push` と `git push` は同じもの扱いです
- `*` 以外の特殊文字（`.` `+` など）はすべて文字として扱います

## 判定の順序

エスカレーション → ①ワークスペース拒否リスト → ②ワークスペース許可リスト
→ ③セッション許可 → どれも不一致なら従来どおりユーザーに質問。

## /cmdperm セッションコマンド

| コマンド | 意味 |
| --- | --- |
| `/cmdperm session list` | このセッションの許可パターン一覧 |
| `/cmdperm session add <パターン>` | セッション許可を追加（保存される） |
| `/cmdperm session remove <パターン>` | 削除 |
| `/cmdperm session clear` | このセッション分を全消去 |
| `/cmdperm workspace allow add <パターン>` | ワークスペース許可リストに追加 |
| `/cmdperm workspace deny add <パターン>` | ワークスペース拒否リストに追加 |
| `/cmdperm workspace <id> list` | ワークスペースのリスト表示 |
| `/cmdperm workspace <id> save <json>` | リスト保存（ダイアログが内部使用） |

## インストール

### A. Git リポジトリから

Plugin Manager の「パス/URL指定」でインストールできます

```
github:yukieiji/dsh-command-permission
```

### C. ローカルフォルダから

```bash
git clone <このリポジトリ>
cd dsh-command-permission
pnpm install && pnpm build
```

Plugin Manager → 追加 → **パス指定**でそのフォルダを指定 → 有効化 → ページリロード。

## 開発

```bash
pnpm install
pnpm build   # tsc -p . → dist/
pnpm lint    # oxlint（curly 必須 = 波括弧なし if はエラー）
pnpm test    # vitest（ホスト30 + クライアント11 = 41 テスト）
pnpm check   # build + lint + test まとめて
```

- `src/index.ts` — ホスト側。`approval/request` の prepend リスナーと `/cmdperm` コマンド
- `src/client.ts` — クライアント側。承認詳細のスロット（priority -1 で既存表示をシャドウ）と
  ワークスペース右クリックメニュー/ダイアログ
- `tests/` — vitest。ホストは fake ctx、クライアントは fake React/`__ModuleLoader__` で実行

## 制限事項

- ワークスペース右クリックはサイドバーのワークスペース行のみ（「グループなし」行は対象外）
- パターンはシェルコマンド（`command` 引数を持つツール）にのみ作用。
  fs ツールのファイル操作エスカレーションは従来どおり質問されます
- `session` セクションはセッションID単位で残ります。不要分は `/cmdperm session clear`
  かファイル編集で掃除してください

## ライセンス

MIT
