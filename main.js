document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const cashBalanceEl = document.getElementById('cash-balance');
    const btcHoldingEl = document.getElementById('btc-holding');
    const ethHoldingEl = document.getElementById('eth-holding');
    const cryptoSelectEl = document.getElementById('crypto-select');
    const tradeAmountEl = document.getElementById('trade-amount');
    const buyBtn = document.getElementById('buy-btn');
    const sellBtn = document.getElementById('sell-btn');

    // --- Chart Objects ---
    let btcChart, ethChart;
    let btcCandlestickSeries, ethCandlestickSeries;

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

    function saveState() {
        localStorage.setItem('cryptoPortfolio', JSON.stringify(portfolio));
    }

    // --- Charting ---
    function createChart(containerId) {
        const chartElement = document.getElementById(containerId);
        const chart = LightweightCharts.createChart(chartElement, {
            width: chartElement.clientWidth,
            height: 300,
            layout: {
                backgroundColor: '#2c2c2c',
                textColor: 'rgba(255, 255, 255, 0.9)',
            },
            grid: {
                vertLines: { color: '#444' },
                horzLines: { color: '#444' },
            },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            rightPriceScale: { borderColor: '#71649C' },
            timeScale: { borderColor: '#71649C' },
        });
        return chart;
    }

    async function fetchKlineData(symbol, interval = '1', limit = '100') {
        try {
            const response = await fetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`);
            if (!response.ok) throw new Error('Network response was not ok');
            const data = await response.json();
            if (data.retCode !== 0) throw new Error('Bybit API returned an error');
            
            // Bybit returns [timestamp, open, high, low, close, volume, turnover]
            // Lightweight charts needs { time, open, high, low, close }
            return data.result.list.map(d => ({
                time: parseInt(d[0]) / 1000,
                open: parseFloat(d[1]),
                high: parseFloat(d[2]),
                low: parseFloat(d[3]),
                close: parseFloat(d[4]),
            })).reverse(); // Bybit sends newest first, so reverse it
        } catch (error) {
            console.error(`Failed to fetch kline data for ${symbol}:`, error);
            return [];
        }
    }

    // --- UI Updates ---
    function updatePortfolioUI() {
        cashBalanceEl.textContent = `$${portfolio.cash.toFixed(2)}`;
        btcHoldingEl.textContent = portfolio.BTC.toFixed(6);
        ethHoldingEl.textContent = portfolio.ETH.toFixed(6);
    }

    async function updateRealtimeData() {
        try {
            const response = await fetch('https://api.bybit.com/v5/market/tickers?category=spot');
            const data = await response.json();
            if (data.retCode !== 0) return;

            const btcData = data.result.list.find(t => t.symbol === 'BTCUSDT');
            const ethData = data.result.list.find(t => t.symbol === 'ETHUSDT');

            if (btcData) {
                const price = parseFloat(btcData.lastPrice);
                marketData.BTC.price = price;
                const lastCandle = btcCandlestickSeries.dataByIndex(btcCandlestickSeries.data().length - 1);
                lastCandle.close = price; // just update the close for a simple tick effect
                if (price > lastCandle.high) lastCandle.high = price;
                if (price < lastCandle.low) lastCandle.low = price;
                btcCandlestickSeries.update(lastCandle);
            }

            if (ethData) {
                const price = parseFloat(ethData.lastPrice);
                marketData.ETH.price = price;
                const lastCandle = ethCandlestickSeries.dataByIndex(ethCandlestickSeries.data().length - 1);
                lastCandle.close = price;
                if (price > lastCandle.high) lastCandle.high = price;
                if (price < lastCandle.low) lastCandle.low = price;
                ethCandlestickSeries.update(lastCandle);
            }
        } catch (error) {
            console.error("Failed to fetch ticker data:", error);
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
            if (portfolio.cash < cost) {
                alert('현금이 부족합니다.');
                return;
            }
            portfolio.cash -= cost;
            portfolio[crypto] += amount;
            alert(`${amount} ${crypto}를 성공적으로 매수했습니다.`);
        } else if (type === 'sell') {
            if (portfolio[crypto] < amount) {
                alert('보유 수량이 부족합니다.');
                return;
            }
            portfolio.cash += cost;
            portfolio[crypto] -= amount;
            alert(`${amount} ${crypto}를 성공적으로 매도했습니다.`);
        }

        tradeAmountEl.value = '';
        saveState();
        updatePortfolioUI();
    }

    // --- Initialization ---
    async function initializeApp() {
        // State
        const savedPortfolio = localStorage.getItem('cryptoPortfolio');
        portfolio = savedPortfolio ? JSON.parse(savedPortfolio) : { ...initialPortfolio };
        saveState();
        updatePortfolioUI();

        // Charts
        btcChart = createChart('btc-chart');
        ethChart = createChart('eth-chart');
        btcCandlestickSeries = btcChart.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350' });
        ethCandlestickSeries = ethChart.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350' });

        const btcKline = await fetchKlineData('BTCUSDT');
        const ethKline = await fetchKlineData('ETHUSDT');
        btcCandlestickSeries.setData(btcKline);
        ethCandlestickSeries.setData(ethKline);
        
        // Start live updates
        updateRealtimeData(); // Initial fetch
        setInterval(updateRealtimeData, 3000);
    }
    
    // --- Event Listeners ---
    buyBtn.addEventListener('click', () => {
        const amount = parseFloat(tradeAmountEl.value);
        if (amount > 0) executeTrade('buy', cryptoSelectEl.value, amount);
        else alert('유효한 수량을 입력하세요.');
    });

    sellBtn.addEventListener('click', () => {
        const amount = parseFloat(tradeAmountEl.value);
        if (amount > 0) executeTrade('sell', cryptoSelectEl.value, amount);
        else alert('유효한 수량을 입력하세요.');
    });

    initializeApp();
});
