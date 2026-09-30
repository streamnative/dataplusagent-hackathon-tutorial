"""L4 - Agent acts, human approves.

Lets your agent insert into flagged_accounts, but only with your approval: the
tool has an `always_ask` policy, so the session pauses until you decide.

    python l4_act.py
"""

from common import (
    agent_params,
    ask_human,
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

REQUEST = "Flag the account most likely to be under attack right now."


def main() -> None:
    config = load_config(["ORCA_BASE_URL", "ORCA_MODEL", "SN_MCP_URL"])
    client = orca_client(config)
    state = state_for(config)
    environment_id = ensure_environment(client, state, f"hello-env-{config.participant}")

    # Next version again: agent/l4-act.json enables one write tool, always_ask.
    layer = load_layer("l4-act")
    agent = ensure_agent(client, state, agent_params(layer, config))
    print(f"{agent.name} v{agent.version}: {layer['summary']}")

    vault_id = ensure_vault(client, state, f"hello-vault-{config.participant}", config)
    session = client.sessions.create(
        environment_id=environment_id,
        agent={"type": "agent", "id": agent.id, "version": agent.version},
        vault_ids=[vault_id],
        title="L4: act with approval",
    )

    # ask_human is called whenever the session pauses for approval.
    chat(client, session.id, REQUEST, confirm=ask_human)


if __name__ == "__main__":
    run_main(main)
