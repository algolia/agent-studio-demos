// ==================== SHARED COMPONENTS FOR MÉMOIRES DEMOS ====================

// Topic emoji mapping (18 predefined categories)
const TOPIC_EMOJIS = {
    'preferences': '⚙️',
    'shopping': '🛒',
    'food': '🍽️',
    'work': '💼',
    'health': '🏥',
    'travel': '✈️',
    'entertainment': '🎬',
    'family': '👨‍👩‍👧‍👦',
    'hobbies': '🎨',
    'goals': '🎯',
    'history': '📜',
    'feedback': '💬',
    'complaints': '😤',
    'praise': '👏',
    'technical': '⚙️',
    'learning': '📚',
    'schedule': '📅',
    'finance': '💰'
};

// Get topic badge with emoji
function getTopicBadge(topic) {
    const emoji = TOPIC_EMOJIS[topic.toLowerCase()] || '📌';
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-100 text-indigo-800 rounded text-xs font-semibold">${emoji} ${escapeHtml(topic)}</span>`;
}

// HTML escape utility
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Inject footer into page
function injectFooter() {
    const footer = document.createElement('footer');
    footer.className = 'mt-12 py-6 border-t border-gray-200 bg-white';
    footer.innerHTML = `
        <div class="container mx-auto px-6 max-w-screen-2xl">
            <div class="flex flex-wrap justify-center items-center gap-6 text-sm text-gray-600">
                <span class="font-semibold text-gray-800">A PLN Demo</span>
                <span class="text-gray-300">•</span>
                <a href="https://www.algolia.com/doc/guides/algolia-ai/agent-studio/" target="_blank" class="text-indigo-600 hover:text-indigo-800 hover:underline">
                    📚 Agent Studio Docs
                </a>
                <span class="text-gray-300">•</span>
                <a href="https://www.algolia.com/products/ai/agent-studio" target="_blank" class="text-indigo-600 hover:text-indigo-800 hover:underline">
                    🚀 Product Page
                </a>
            </div>
        </div>
    `;
    document.body.appendChild(footer);
}

// Header navigation — one demo ships here, so a single static label
function getHeaderNavigation(currentDemo) {
    return `
        <div class="flex justify-center items-center gap-4 text-sm">
            <span class="font-semibold text-indigo-600">Agent Memory Comparison</span>
        </div>
    `;
}

// Common CSS animations
const SHARED_STYLES = `
    .message { animation: slideIn 0.2s ease-out; }
    @keyframes slideIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
    }
    .loading, .streaming { animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
    }
`;

// Initialize shared components on page load
function initSharedComponents(demoName) {
    injectFooter();
}
