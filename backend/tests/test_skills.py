from pathlib import Path

from archon_server.services.skills import SkillService


def test_skill_list_handles_malformed_yaml(tmp_path: Path):
    skill = tmp_path / "demo"
    skill.mkdir()
    (skill / "SKILL.md").write_text("---\n- not a mapping\n---\nbody")
    config = tmp_path / "config.yaml"
    config.write_text("- not a mapping\n")

    result = SkillService(tmp_path, config).list()

    assert result[0]["name"] == "demo"
