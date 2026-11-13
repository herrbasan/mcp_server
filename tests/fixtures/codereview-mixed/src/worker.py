import requests


def load_review(review_id):
    return requests.get(f"https://example.invalid/reviews/{review_id}", timeout=10).json()
