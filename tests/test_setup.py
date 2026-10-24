"""Small smoke test confirming PyTest discovers and runs repository tests."""


def test_pytest_setup():
    assert sum([1, 2, 3]) == 6
