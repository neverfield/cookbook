class FtpSource:
    def __init__(self, username, password, host):
        self.username = username
        self.password = password
        self.host = host

    def url(self):
        return f'ftp://{self.username}:{self.password}@{self.host}/'


LEGACY = 'ftp://%(user)s:%(password)s@%(host)s/'
TEMPLATE = 'sftp://{0}:{1}@{2}/'
