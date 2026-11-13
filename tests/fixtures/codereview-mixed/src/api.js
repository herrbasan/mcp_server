export async function loadReview(id) {
    const response = await fetch(`https://example.invalid/reviews/${id}`);
    return response.json();
}
