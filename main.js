document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const btcLivePriceEl = document.getElementById('btc-live-price');
    const ethLivePriceEl = document.getElementById('eth-live-price');
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
        cash: 10000000, // Starting with 10,000,000 KRW
        BTC: 0,
        ETH: 0
    };

    function saveState() {
        localStorage.setItem('cryptoPortfolio', JSON.stringify(portfolio));
    }

    // --- Charting ---
    function createChart(containerId) {
        const chartElement = document.getElementById(containerId);
        // Ensure the chart container takes full width
        chartElement.style.width = '100%'; 
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

    async function fetchUpbitKlineData(market, unit = 'minutes', count = 100) {
        try {
            // Upbit's candles/minutes API uses count for number of candles
            const url = `https://api.upbit.com/v1/candles/${unit}/1?market=${market}&count=${count}`;
            const response = await fetch(url);
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Network response was not ok: ${response.status} - ${errorText}`);
            }
            const data = await response.json();
            
            // Upbit returns newest first, reverse for Lightweight Charts
            // Upbit data: { market, candle_date_time_utc, opening_price, high_price, low_price, trade_price, timestamp }
            return data.map(d => ({
                time: new Date(d.candle_date_time_utc).getTime() / 1000, // Convert to seconds
                open: d.opening_price,
                high: d.high_price,
                low: d.low_price,
                close: d.trade_price,
            })).reverse();
        } catch (error) {
            console.error(`Failed to fetch kline data for ${market}:`, error);
            return [];
        }
    }

    // --- UI Updates ---
    function updatePortfolioUI() {
        cashBalanceEl.textContent = `${portfolio.cash.toLocaleString()} KRW`;
        btcHoldingEl.textContent = portfolio.BTC.toFixed(6);
        ethHoldingEl.textContent = portfolio.ETH.toFixed(6);
    }
    
    async function updateRealtimeData() {
        try {
            const response = await fetch('https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-ETH');
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Network response was not ok: ${response.status} - ${errorText}`);
            }
            const data = await response.json(); // This is an array
            
            const btcTicker = data.find(t => t.market === 'KRW-BTC');
            const ethTicker = data.find(t => t.market === 'KRW-ETH');

            if (btcTicker) {
                const price = btcTicker.trade_price;
                marketData.BTC.price = price;
                btcLivePriceEl.textContent = `${price.toLocaleString()} KRW`;
                // Update chart's last candle
                const lastCandle = btcCandlestickSeries.dataByIndex(btcCandlestickSeries.data().length - 1);
                // Only update if current time is within the last minute of the last candle
                // Or simply update the close price of the last known candle
                if (lastCandle) {
                     // Check if it's a new minute or update current minute
                    const currentTime = Math.floor(Date.now() / 1000);
                    const lastCandleTime = lastCandle.time;
                    const oneMinute = 60;
                    if (currentTime - lastCandleTime >= oneMinute) {
                        // New minute, add a new candle
                        const newCandle = {
                            time: currentTime,
                            open: price,
                            high: price,
                            low: price,
                            close: price,
                        };
                        btcCandlestickSeries.update(newCandle);
                    } else {
                        // Same minute, update current candle
                        const updatedCandle = { ...lastCandle, close: price };
                        if (price > updatedCandle.high) updatedCandle.high = price;
                        if (price < updatedCandle.low) updatedCandle.low = price;
                        btcCandlestickSeries.update(updatedCandle);
                    }
                }
            }

            if (ethTicker) {
                const price = ethTicker.trade_price;
                marketData.ETH.price = price;
                ethLivePriceEl.textContent = `${price.toLocaleString()} KRW`;
                // Update chart's last candle
                const lastCandle = ethCandlestickSeries.dataByIndex(ethCandlestickSeries.data().length - 1);
                if (lastCandle) {
                    const currentTime = Math.floor(Date.now() / 1000);
                    const lastCandleTime = lastCandle.time;
                    const oneMinute = 60;
                    if (currentTime - lastCandleTime >= oneMinute) {
                        const newCandle = {
                            time: currentTime,
                            open: price,
                            high: price,
                            low: price,
                            close: price,
                        };
                        ethCandlestickSeries.update(newCandle);
                    } else {
                        const updatedCandle = { ...lastCandle, close: price };
                        if (price > updatedCandle.high) updatedCandle.high = price;
                        if (price < updatedCandle.low) updatedCandle.low = price;
                        ethCandlestickSeries.update(updatedCandle);
                    }
                }
            }
        } catch (error) {
            console.error("Failed to fetch Upbit ticker data:", error);
            btcLivePriceEl.textContent = 'Error';
            ethLivePriceEl.textContent = 'Error';
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

        // Fetch historical data
        const btcKline = await fetchUpbitKlineData('KRW-BTC');
        const ethKline = await fetchUpbitKlineData('KRW-ETH');
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