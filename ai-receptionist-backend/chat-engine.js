/**
 * Server-side chat response logic.
 *
 * This is a direct port of the matching logic that used to live in
 * receptionist-engine.html's client-side JavaScript. Moving it here means
 * the browser never receives the product catalog until AFTER the server has
 * confirmed a valid age-verification token — the catalog literally cannot
 * leak to an unverified visitor because it never reaches their browser.
 */

function generateChatResponse(query, config) {
  const text = query.toLowerCase();
  const identity = config.identity || {};
  const categories = [...((config.products && config.products.categories) || [])];

  // If Square is connected, its synced items become additional categories —
  // same behavior as before, just evaluated server-side now.
  const pos = config.pos_connection;
  if (pos && pos.connected && pos.mock_catalog && pos.mock_catalog.length) {
    const byCategory = pos.mock_catalog_by_category || {};
    Object.keys(byCategory).forEach(categoryName => {
      if (categoryName === 'Uncategorized') return;
      const words = categoryName.toLowerCase().split(/\s+/).filter(Boolean);
      categories.push({
        key: 'square_' + categoryName.toLowerCase().replace(/\s+/g, '_'),
        label: `${categoryName} (synced from Square)`,
        keywords: [categoryName.toLowerCase(), ...words],
        items: byCategory[categoryName]
      });
    });

    categories.push({
      key: 'square_synced',
      label: 'Live Inventory (synced from Square)',
      keywords: ['square', 'live', 'synced', 'inventory', 'stock'],
      items: pos.mock_catalog
    });
  }

  let response = null;

  for (const cat of categories) {
    const matched = (cat.keywords || []).some(k => text.includes(k.toLowerCase()));
    if (matched) {
      response = `Here's what we have in ${cat.label}:\n\n`;
      (cat.items || []).forEach((item, i) => {
        response += `${i + 1}. ${item.name} - ${item.price}\n   ${item.details || ''}\n\n`;
      });
      break;
    }
  }

  if (!response && (text.includes('hour') || text.includes('open') || text.includes('close'))) {
    response = `⏰ ${identity.hours_display}`;
  }
  if (!response && (text.includes('address') || text.includes('location') || text.includes('where'))) {
    response = `📍 ${identity.address}`;
  }
  if (!response && (text.includes('hi') || text.includes('hello') || text.includes('hey'))) {
    response = 'Hey! What can I help you find today?';
  }
  if (!response) {
    const categoryList = categories.map(c => `✓ ${c.label}`).join('\n');
    response = `I can help with:\n\n${categoryList}\n✓ Hours & location\n\nWhat are you interested in?`;
  }

  return response;
}

module.exports = { generateChatResponse };
