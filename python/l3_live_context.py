"""L3 - Agent + live context.

Upgrades your agent with read-only StreamNative MCP tools, gives the session a
vault holding the MCP credential, and opens a conversation. Ask, run
`python inject.py` in a second terminal, then ask again: the answer changes.

    python l3_live_context.py
"""

from common import (
    agent_params,
    chat,
    ensure_agent,
    ensure_environment,
    ensure_vault,
    load_config,
    load_layer,
    orca_client,
    run_main,
    state_for,
)

QUESTION = "Which accounts look like an account takeover right now?"


def main() -> None:
    config = load_config(["ORCA_BASE_URL", "ORCA_MODEL", "SN_MCP_URL"])
    client = orca_client(config)
    state = state_for(config)
    environment_id = ensure_environment(client, state, f"hello-env-{config.participant}")

    # The same agent, next version: agent/l3-live-context.json adds the MCP server.
    layer = load_layer("l3-live-context")
    agent = ensure_agent(client, state, agent_params(layer, config))
    print(f"{agent.name} v{agent.version}: {layer['summary']}")

    # The MCP server needs a credential. It goes in a vault, never in the prompt.
    vault_id = ensure_vault(client, state, f"hello-vault-{config.participant}", config)

    session = client.sessions.create(
        environment_id=environment_id,
        agent={"type": "agent", "id": agent.id, "version": agent.version},
        vault_ids=[vault_id],
        title="L3: live context",
    )
    print("Tip: after the first answer, run `python inject.py` in another terminal and ask again.\n")
    chat(client, session.id, QUESTION)


if __name__ == "__main__":
    run_main(main)
