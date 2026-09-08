from pathlib import Path

from archon_server.services.agents import AgentService


def test_agent_list_skips_malformed_profile_config(tmp_path: Path):
    profile = tmp_path / "profiles" / "default"
    profile.mkdir(parents=True)
    (profile / "config.yaml").write_text("model: [unclosed\n")
    (profile / "profile.yaml").write_text("description: [unclosed\n")
    (tmp_path / "config.yaml").write_text("kanban: [unclosed\n")

    agents = AgentService(tmp_path, "default").list()

    assert agents[0]["name"] == "default"
    assert agents[0]["model"] == ""
