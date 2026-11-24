# A public API key the app ships for its own client; the service issues it per application.
API_KEY = 'b3f1c9a7d2e84f6a9c0d1e2f3a4b5c6d'


def url(path):
    return f'https://api.movies.example/3/{path}?api_key={API_KEY}'
