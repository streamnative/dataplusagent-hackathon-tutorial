"""L1 - Hello, agent.

Creates your agent (no tools yet), starts a session, and says hello.

    python l1_hello.py                      # asks a default question
    python l1_hello.py "your own question"
"""

import sys

from common import agent_params, ensure_agent, ensure_environment, load_config, load_layer, orca_client, run_main, run_turn, state_for

QUESTION = "Hi! What is the Data + Agent Hackathon, and what can you see right now?"


def main() -> None:
    config = load_config(["ORCA_BASE_URL", "ORCA_MODEL"])
    client = orca_client(config)
    state = state_for(config)

    # 1. An environment: where your agent's sessions run.
    environment_id = ensure_environment(client, state, f"hello-env-{config.participant}")

    # 2. An agent: a model plus a system prompt, from agent/l1-hello.json.
    layer = load_layer("l1-hello")
    agent = ensure_agent(client, state, agent_params(layer, config))
    print(f"{agent.name} v{agent.version}: {layer['summary']}")

    # 3. A session: one conversation, pinned to this exact agent version.
    session = client.sessions.create(
        environment_id=environment_id,
        agent={"type": "agent", "id": agent.id, "version": agent.version},
        title="L1: hello",
    )

    # 4. Send a message and stream the agent's reply.
    question = " ".join(sys.argv[1:]) or QUESTION
    print(f"[you]    {question}")
    run_turn(client, session.id, question)


if __name__ == "__main__":
    run_main(main)
