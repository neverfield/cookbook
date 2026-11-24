import os

# The deploy key a maintainer committed by mistake. Fake value; the shape is what matters.
AWS_ACCESS_KEY_ID = 'AKIAQQQQFAKEKEY11111'
DATABASE_URL = os.environ.get('DATABASE_URL', 'postgres://localhost/mediabot')
