# Before you arrive

Twenty minutes at home saves an hour at the event. This page prepares your
laptop and your StreamNative Cloud instance for the
[Cloud course](../labs/cloud/README.md), the one you take at the hackathon. Pick
**one** path.

| Path | Install |
|---|---|
| **Python** | Python 3.11 or newer |
| **TypeScript** | Node.js 20 or newer |
| **CLI** | Python 3.11+ *or* Node.js 20+, for three helper scripts (the doctor, the seeder, and the data injector) |

Everyone also needs:

- `git` and a terminal that runs `bash`. On Windows that is WSL or Git Bash, on
  every path: the checks in the labs are `bash` commands.
- [`ork`](https://github.com/orca-ae/orca-cli) (the Orca CLI), v0.6.0 or newer:
  `brew install orca-ae/tap/ork`, or a
  [release archive](https://github.com/orca-ae/orca-cli/releases) unpacked onto
  your `PATH`. All three paths use it for the first MCP login in Lab 3, and for
  the checks in every lab. Check
  `ork agent vaults credentials create --help` for `--oauth-issuer` and
  `--oauth-allow-issuer-mismatch`: a build with those flags handles
  StreamNative's same-domain proxy issuer aliases and dynamic client
  authentication. Leave `SN_MCP_OAUTH_ISSUER` empty for this flow;
  `--oauth-issuer` only selects an authorization server advertised by the MCP
  server when a choice is needed. The browser flow stores tokens directly in the
  vault.
- [`jq`](https://jqlang.org/download/), for the checks in every lab.
- [`snctl`](https://docs.streamnative.io/tools/cli/snctl/snctl-overview) (the
  StreamNative Cloud CLI): `brew install streamnative/streamnative/snctl`. Lab 0
  uses it to read your instance's addresses and to create your topic.

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

`python3 --version` has to say 3.11 or newer. On macOS, Apple's own `python3`
is 3.9, and with it `pip` stops at
`No matching distribution found for runorca`. Install a newer Python and name it
in the second line, for example `python3.13 -m venv .venv`.

**TypeScript**

```bash
cd typescript
npm install
```

**CLI**: install `ork` and `jq`, then set up Python or TypeScript as above for
the doctor, the seeder, and the injector.

## 3. Check your laptop

```bash
python doctor.py --offline         # Python or CLI path
npm run doctor -- --offline        # TypeScript path
```

Every line should say `PASS`.

## 4. Set up your instance

The organizers add you to the hackathon organization on StreamNative Cloud, give
you an **instance** of your own, and make a **service account** in it. They give
you its name and its **API key**: keep the key to yourself.

In the StreamNative Cloud console, create three things in your instance, in the
region the organizers name:

- a **Kafka cluster** (Serverless),
- an **agent workspace**,
- a **SQL workspace** that imports your Kafka cluster.

Then log `snctl` in and check that all three are there:

```bash
snctl config init
snctl auth login                          # opens your browser
snctl config set --organization <org>     # the hackathon organization's id, o-...
snctl get kafkaclusters -o custom-columns=NAME:.metadata.name,INSTANCE:.spec.instanceName
snctl get workspaces -o custom-columns=NAME:.metadata.name,INSTANCE:.spec.instanceName
snctl get sqlcatalogs -o custom-columns=NAME:.metadata.name,KAFKA_CLUSTER:.spec.sourceRef.name,SQL_WORKSPACE:.spec.workspaceRef.name
```

The first two lists have a row for your instance, and the SQL catalog list has a
row that names your Kafka cluster and your SQL workspace.
[Lab 0](../labs/cloud/00-set-up.md) reads their addresses into `.env`.

## Want to try it tonight?

The [Local course](../labs/local/README.md) is the same five labs on your own
laptop, with nothing on StreamNative Cloud: Ursa for Kafka, RisingWave, and the
Orca Agent Engine in Docker. It needs Docker and an Anthropic API key, and
downloads about 5 GB of images, so start it on a good connection.
