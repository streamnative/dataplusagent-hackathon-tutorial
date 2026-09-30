# Before you arrive

Ten minutes at home saves thirty at the event. Pick **one** path; your teammate
can pick a different one.

| Path | Install |
|---|---|
| **Python** | Python 3.11 or newer |
| **TypeScript** | Node.js 20 or newer |
| **CLI** | [`ork`](https://github.com/orca-ae/orca-cli) (the Orca CLI) and [`jq`](https://jqlang.org/download/), plus Python 3.11+ *or* Node.js 20+ for two helper scripts |

Everyone also needs `git`, a terminal, and [`ork`](https://github.com/orca-ae/orca-cli)
for the first OAuth MCP login in L3/L4, including the Python and TypeScript paths.
Use current `orca-cli` main or a build containing [PR #8](https://github.com/orca-ae/orca-cli/pull/8).
Check `ork agent vaults credentials create --help` for `--oauth-issuer` and
`--oauth-allow-issuer-mismatch`. Automatic discovery handles StreamNative's
same-domain proxy issuer aliases and dynamic client authentication. Leave
`SN_MCP_OAUTH_ISSUER` empty for this flow; `--oauth-issuer` only selects an
authorization server advertised by the MCP server when a choice is needed.
The browser flow stores tokens directly in the vault.
On Windows, use WSL or Git Bash for the CLI path.

## 1. Get the code

Clone the repository linked in your invitation email, and `cd` into it.

## 2. Install your path's dependencies

**Python**

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

**TypeScript**

```bash
cd typescript
npm install
```

**CLI**: install `ork` and `jq`, then set up Python or TypeScript as above for
the doctor and the data injector.

## 3. Check your laptop

```bash
python doctor.py --offline         # Python or CLI path
npm run doctor -- --offline        # TypeScript path
```

Every line should say `PASS`. You'll get your **team card** (your credentials
and endpoints) at the event; the online checks run then.
