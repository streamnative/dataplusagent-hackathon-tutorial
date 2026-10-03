# Before you arrive

Ten minutes at home saves thirty at the event. This page prepares your laptop
for the [Cloud course](../labs/cloud/README.md), the one you take at the
hackathon. Pick **one** path; your teammate can pick a different one.

| Path | Install |
|---|---|
| **Python** | Python 3.11 or newer |
| **TypeScript** | Node.js 20 or newer |
| **CLI** | Python 3.11+ *or* Node.js 20+, for two helper scripts (the doctor and the data injector) |

Everyone also needs:

- `git` and a terminal that runs `bash`. On Windows that is WSL or Git Bash, on
  every path: the checks in the labs are `bash` commands.
- [`ork`](https://github.com/orca-ae/orca-cli) (the Orca CLI), v0.6.0 or newer:
  `brew install orca-ae/tap/ork`. All three paths use it for the first MCP login
  in Lab 3, and for the checks in every lab. Check
  `ork agent vaults credentials create --help` for `--oauth-issuer` and
  `--oauth-allow-issuer-mismatch`: a build with those flags handles
  StreamNative's same-domain proxy issuer aliases and dynamic client
  authentication. Leave `SN_MCP_OAUTH_ISSUER` empty for this flow;
  `--oauth-issuer` only selects an authorization server advertised by the MCP
  server when a choice is needed. The browser flow stores tokens directly in the
  vault.
- [`jq`](https://jqlang.org/download/), for the checks in every lab.

## 1. Get the code

Clone the repository linked in your invitation email, and `cd` into it.

## 2. Install your path's dependencies

**Python**

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate        # Git Bash on Windows: source .venv/Scripts/activate
pip install -r requirements.txt
```

**TypeScript**

```bash
cd typescript
npm install
```

**CLI**: install `ork` and `jq`, then set up Python or TypeScript as above for
the doctor and the injector.

## 3. Check your laptop

```bash
python doctor.py --offline         # Python or CLI path
npm run doctor -- --offline        # TypeScript path
```

Every line should say `PASS`. You'll get your **team card** (your credentials
and endpoints) at the event; [Lab 0](../labs/cloud/00-set-up.md) starts there.

## Want to try it tonight?

The [Local course](../labs/local/README.md) is the same five labs on your own
laptop, with no team card: Ursa for Kafka, RisingWave, and the Orca Agent
Engine in Docker. It needs Docker and an Anthropic API key, and downloads about
5 GB of images, so start it on a good connection.
