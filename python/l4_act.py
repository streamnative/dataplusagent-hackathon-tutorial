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
    load_config,
    load_layer,
    mcp_vault_ids,
    open_session,
    orca_client,
    run_main,
    state_for,
)

REQUEST = "Flag the account most likely to be under attack right now."


def main() -> None:
    config = load_config(["ORCA_BASE_URL", "ORCA_MODEL"])
    client = orca_client(config)
    state = state_for(config)
    environment_id = ensure_environment(client, state, f"hello-env-{config.participant}")

    # Next version again: agent/<stack>/l4-act.json enables one write tool, always_ask.
    layer = load_layer("l4-act", config.stack)
    agent = ensure_agent(client, state, agent_params(layer, config))
    print(f"{agent.name} v{agent.version}: {layer['summary']}")

    vault_ids = mcp_vault_ids(client, state, config)
    session = open_session(client, state, environment_id, agent, "L4: act with approval", vault_ids=vault_ids)

    # ask_human is called whenever the session pauses for approval.
    chat(client, session.id, REQUEST, confirm=ask_human, send_first=config.stack == "local")


if __name__ == "__main__":
    run_main(main)
