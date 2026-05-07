export async function onRequestGet(context) {
  const GAS_URL = 'https://script.google.com/macros/s/AKfycbzb-IRbn6OoJJDHsv8lREJjZxC9ASfSJnIqjY_bK6pKKXc7kZcmnt1Ke4kD1T7p85GfoQ/exec';
  try {
    const res = await fetch(
      GAS_URL + '?orderId=WOG0lYk&mode=api',
      { redirect: 'follow' }
    );
    const text = await res.text();
    return new Response(text, {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response('Error: ' + err.message, { status: 500 });
    
  }
}
