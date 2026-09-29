"""Remove the agent, vault, and environment your scripts created.

    python cleanup.py

Your SQL objects stay; drop them with sql/99_reset.sql.
"""

from common import cleanup, load_config, orca_client, run_main, state_for


def main() -> None:
    config = load_config(["ORCA_BASE_URL", "SN_API_KEY"])
    cleanup(orca_client(config), state_for(config))


if __name__ == "__main__":
    run_main(main)
