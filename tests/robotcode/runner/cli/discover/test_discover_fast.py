from importlib import import_module
from pathlib import Path
from textwrap import dedent

import pytest
from robot.model import TagPatterns

discover = import_module("robotcode.runner.cli.discover.discover")


def _write_robot(path: Path, content: str) -> None:
    path.write_text(dedent(content).strip() + "\n", encoding="utf-8")


def test_extract_force_tags_from_path_supports_continuation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discover, "_stdin_data", None)

    suite = tmp_path / "suite.robot"
    _write_robot(
        suite,
        """
        *** Settings ***
        Force Tags    parent    smoke
        ...    fast
        ...    smoke

        *** Test Cases ***
        Example
            No Operation
        """,
    )

    assert discover._extract_force_tags_from_path(suite) == ["parent", "smoke", "fast"]


def test_get_cached_inherited_force_tags_collects_parent_init_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(discover, "_stdin_data", None)

    level1 = tmp_path / "level1"
    level2 = level1 / "level2"
    level2.mkdir(parents=True)

    _write_robot(
        level1 / "__init__.robot",
        """
        *** Settings ***
        Force Tags    root
        """,
    )
    _write_robot(
        level2 / "__init__.robot",
        """
        *** Settings ***
        Force Tags    middle
        """,
    )

    suite = level2 / "suite.robot"
    _write_robot(
        suite,
        """
        *** Settings ***
        Force Tags    file

        *** Test Cases ***
        Example
            No Operation
        """,
    )

    inherited = discover._get_cached_inherited_force_tags(suite, tmp_path, {}, {})

    assert set(inherited) == {"root", "middle", "file"}
    assert inherited[-1] == "file"


def test_extract_fast_items_from_path_collects_tags_with_continuation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(discover, "_stdin_data", None)

    suite = tmp_path / "suite.robot"
    _write_robot(
        suite,
        """
        *** Test Cases ***
        First Test
            [Tags]    smoke    fast
            ...    api
            No Operation

        Second Test
            [Tags]    db    db
            No Operation
        """,
    )

    items = discover._extract_fast_items_from_path(suite)

    assert len(items) == 2
    assert items[0][0] == "test"
    assert items[0][1] == "First Test"
    assert items[0][2] > 0
    assert items[0][3] == ["smoke", "fast", "api"]

    assert items[1][0] == "test"
    assert items[1][1] == "Second Test"
    assert items[1][2] > 0
    assert items[1][3] == ["db"]


def test_fast_match_tags_applies_include_and_exclude_patterns() -> None:
    include = TagPatterns(["smoke"])
    exclude = TagPatterns(["flaky"])

    assert discover._fast_match_tags(["smoke", "api"], include, exclude)
    assert not discover._fast_match_tags(["api"], include, exclude)
    assert not discover._fast_match_tags(["smoke", "flaky"], include, exclude)
