document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const btcPriceEl = document.getElementById('btc-price');
    const btcVolumeEl = document.getElementById('btc-volume');
    const ethPriceEl = document.getElementById('eth-price');
    const ethVolumeEl = document.getElementById('eth-volume');
    const cashBalanceEl = document.getElementById('cash-balance');
    const btcHoldingEl = document.getElementById('btc-holding');
    const ethHoldingEl = document.getElementById('eth-holding');
    const cryptoSelectEl = document.getElementById('crypto-select');
    const tradeAmountEl = document.getElementById('trade-amount');
    const buyBtn = document.getElementById('buy-btn');
    const sellBtn = document.getElementById('sell-btn');

    // --- State Management ---
    let portfolio = {};
    let marketData = {
        BTC: { price: 0 },
        ETH: { price: 0 }
    };

    const initialPortfolio = {
        cash: 10000,
        BTC: 0,
        ETH: 0
    };

    function initializeState() {
        const savedPortfolio = localStorage.getItem('cryptoPortfolio');
        if (savedPortfolio) {
            portfolio = JSON.parse(savedPortfolio);
        } else {
            portfolio = { ...initialPortfolio };
            saveState();
        }
        updatePortfolioUI();
    }

    function saveState() {
        localStorage.setItem('cryptoPortfolio', JSON.stringify(portfolio));
    }

    // --- UI Updates ---
    function updatePortfolioUI() {
        cashBalanceEl.textContent = `$${portfolio.cash.toFixed(2)}`;
        btcHoldingEl.textContent = portfolio.BTC.toFixed(6);
        ethHoldingEl.textContent = portfolio.ETH.toFixed(6);
    }
    
    function updateMarketDataUI() {
        // Update BTC
        if (marketData.BTC && marketData.BTC.price) {
            btcPriceEl.textContent = `$${parseFloat(marketData.BTC.price).toFixed(2)}`;
            btcVolumeEl.textContent = `24h Volume: ${parseFloat(marketData.BTC.volume).toLocaleString()}`;
        }
        // Update ETH
        if (marketData.ETH && marketData.ETH.price) {
            ethPriceEl.textContent = `$${parseFloat(marketData.ETH.price).toFixed(2)}`;
            ethVolumeEl.textContent = `24h Volume: ${parseFloat(marketData.ETH.volume).toLocaleString()}`;
        }
    }

    // --- API Client ---
    async function fetchMarketData() {
        try {
            const response = await fetch('https://api.bybit.com/v5/market/tickers?category=spot');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            
            if (data.retCode === 0 && data.result && data.result.list) {
                const btcData = data.result.list.find(t => t.symbol === 'BTCUSDT');
                const ethData = data.result.list.find(t => t.symbol === 'ETHUSDT');

                if (btcData) {
                    marketData.BTC.price = btcData.lastPrice;
                    marketData.BTC.volume = btcData.volume24h;
                }

                if (ethData) {
                    marketData.ETH.price = ethData.lastPrice;
                    marketData.ETH.volume = ethData.volume24h;
                }
                
                updateMarketDataUI();
            } else {
                console.error("Invalid data format from Bybit API:", data);
            }

        } catch (error) {
            console.error("Failed to fetch market data:", error);
            btcPriceEl.textContent = 'Error';
            ethPriceEl.textContent = 'Error';
        }
    }

    // --- Trading Logic ---
    function executeTrade(type, crypto, amount) {
        const price = marketData[crypto].price;
        if (!price || price <= 0) {
            alert('시장 데이터를 사용할 수 없습니다. 잠시 후 다시 시도하세요.');
            return;
        }
        
        const cost = amount * price;

        if (type === 'buy') {
            if (portfolio.cash >= cost) {
                portfolio.cash -= cost;
                portfolio[crypto] += amount;
                alert(`${amount} ${crypto}를 성공적으로 매수했습니다.`);
            } else {
                alert('현금이 부족합니다.');
                return;
            }
        } else if (type === 'sell') {
            if (portfolio[crypto] >= amount) {
                portfolio.cash += cost;
                portfolio[crypto] -= amount;
                alert(`${amount} ${crypto}를 성공적으로 매도했습니다.`);
            } else {
                alert('보유 수량이 부족합니다.');
                return;
            }
        }

        tradeAmountEl.value = '';
        saveState();
        updatePortfolioUI();
    }

    // --- Event Listeners ---
    buyBtn.addEventListener('click', () => {
        const crypto = cryptoSelectEl.value;
        const amount = parseFloat(tradeAmountEl.value);
        if (amount > 0) {
            executeTrade('buy', crypto, amount);
        } else {
            alert('유효한 수량을 입력하세요.');
        }
    });

    sellBtn.addEventListener('click', () => {
        const crypto = cryptoSelectEl.value;
        const amount = parseFloat(tradeAmountEl.value);
        if (amount > 0) {
            executeTrade('sell', crypto, amount);
        } else {
            alert('유효한 수량을 입력하세요.');
        }
    });

    // --- Initialization ---
    initializeState();
    fetchMarketData(); // Initial fetch
    setInterval(fetchMarketData, 3000); // Fetch every 3 seconds
});