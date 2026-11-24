from mediabot.ftp import FtpSource


def test_url_has_host():
    assert FtpSource('u', 'p', 'h').url().endswith('@h/')
