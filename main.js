document.addEventListener('DOMContentLoaded', () => {
    console.log('Script started: DOMContentLoaded');

    // --- CONSTANTS ---
    const LEVERAGE = 20; // Fixed leverage for MVP
    const MMR = 0.005; // Maintenance Margin Rate (0.5%)
    const FEE_RATE = 0.0004; // 0.04% fee per trade
    const SYMBOL = 'BTC-USDT'; // Hardcoded symbol

    // --- SHARED TYPES (from user's prompt, adapted to JS) ---
    /** @typedef { "BUY" | "SELL" } Side */
    /** @typedef { "LONG" | "SHORT" | "FLAT" } PosSide */
    /**
     * @typedef {object} Position
     * @property {PosSide} side
     * @property {number} qty // Always positive
     * @property {number} entryPrice
     * @property {number} [leverage]
     * @property {number} [markPrice]
     * @property {number} [unrealizedPnl]
     * @property {number} [notional]
     * @property {number} [maintenanceMargin]
     * @property {string} [status] // "OPEN" | "CLOSED" | "LIQUIDATED"
     * @property {Date} [updatedAt]
     */
    /**
     * @typedef {object} Fill
     * @property {Side} side
     * @property {number} qty
     * @property {number} price
     */

    // --- STATE (Source of Truth Model - Cross Margin Optimized) ---
    const state = {
        user: {
            uid: 'user-1',
            walletBalance: 10000, // Cash balance
            availableBalance: 10000, // Available for new orders/fees
            equity: 10000, // walletBalance + unrealizedPnlTotal
            unrealizedPnlTotal: 0,
            maintenanceMarginTotal: 0,
            marginMode: "CROSS",
            updatedAt: new Date(),
        },
        positions: {}, // Keyed by symbol, e.g., 'BTC-USDT' -> Position object
        orders: {},    // Keyed by orderId
        trades: {},    // Keyed by tradeId
        ledger: [],    // Array of all financial events
        
        // --- Client-side UI state ---
        ui: {
            orderType: 'limit',
            lastPrice: 60000,
            currentPrice: 60000,
        },
        
        // --- Sequence for IDs ---
        nextOrderId: 1,
        nextTradeId: 1,
        nextLedgerId: 1,
    };

    // --- DOM ELEMENTS ---
    const currentPriceEl = document.getElementById('current-price');
    const balanceDisplayEl = document.getElementById('balance-display');
    const ordersBodyEl = document.getElementById('orders-body');
    const positionsBodyEl = document.getElementById('positions-body');
    const buyBtn = document.getElementById('buy-btn');
    const sellBtn = document.getElementById('sell-btn');
    const priceInput = document.getElementById('price');
    const quantityInput = document.getElementById('quantity');
    const limitOrderInputs = document.getElementById('limit-order-inputs');
    const tabs = document.querySelectorAll('.tab-btn');
    console.log('DOM Elements obtained:', { currentPriceEl, balanceDisplayEl, ordersBodyEl, positionsBodyEl, buyBtn, sellBtn, priceInput, quantityInput, limitOrderInputs, tabs });


    // --- LEDGER & ACCOUNT METRICS LOGIC ---
    /**
     * Adds an entry to the ledger and updates walletBalance.
     * @param {"FEE" | "REALIZED_PNL" | "DEPOSIT" | "WITHDRAW" | "LIQUIDATION_FEE"} type
     * @param {number} deltaWalletBalance
     * @param {object} ref
     */
    function addToLedger(type, deltaWalletBalance, ref = {}) {
        const entry = {
            id: state.nextLedgerId++,
            type,
            deltaWalletBalance,
            ref,
            createdAt: new Date(),
        };
        state.ledger.push(entry);
        state.user.walletBalance += deltaWalletBalance;
        state.user.updatedAt = new Date();
        updateAccountMetrics(); // Re-calculate all derived user metrics
        renderBalance();
        return entry;
    }

    function updateAccountMetrics() {
        // 1. Calculate unrealizedPnlTotal & maintenanceMarginTotal for all positions
        let unrealizedPnlTotal = 0;
        let maintenanceMarginTotal = 0;

        Object.values(state.positions).forEach(pos => {
            if (pos.status === 'OPEN' && pos.qty > 0) {
                // Update position-specific markPrice and unrealizedPnl
                pos.markPrice = state.ui.currentPrice;
                pos.unrealizedPnl = calcUnrealizedPnl(pos, pos.markPrice);
                
                unrealizedPnlTotal += pos.unrealizedPnl;

                // Update position-specific notional and maintenanceMargin
                pos.notional = Math.abs(pos.qty) * pos.markPrice;
                pos.maintenanceMargin = pos.notional * MMR; // Assuming MMR is constant for all tiers for MVP
                maintenanceMarginTotal += pos.maintenanceMargin;
            }
        });
        state.user.unrealizedPnlTotal = unrealizedPnlTotal;
        state.user.maintenanceMarginTotal = maintenanceMarginTotal;

        // 2. Calculate equity
        state.user.equity = state.user.walletBalance + state.user.unrealizedPnlTotal;

        // 3. Calculate availableBalance (funds not locked by orders)
        let lockedByOrders = 0;
        Object.values(state.orders).forEach(o => {
            if (o.status === 'NEW' && o.lockedMarginAmount > 0) {
                lockedByOrders += o.lockedMarginAmount;
            }
        });
        state.user.availableBalance = state.user.walletBalance - lockedByOrders;
    }

    // --- CORE FINANCIAL LOGIC FUNCTIONS (from user's prompt) ---
    /**
     * Applies a fill to a position and returns the updated position and any realized PnL.
     * @param {Position} pos
     * @param {Fill} fill
     * @returns {{pos: Position, realizedPnl: number}}
     */
    function applyFillNet(pos, fill) {
        let realizedPnl = 0;

        // If no existing position or FLAT
        if (pos.side === "FLAT" || pos.qty === 0) {
            const newSide = fill.side === "BUY" ? "LONG" : "SHORT";
            return {
                pos: { side: newSide, qty: fill.qty, entryPrice: fill.price, status: "OPEN" },
                realizedPnl
            };
        }

        const sameDir =
            (pos.side === "LONG" && fill.side === "BUY") ||
            (pos.side === "SHORT" && fill.side === "SELL");

        if (sameDir) {
            // 평균단가 가중평균
            const newQty = pos.qty + fill.qty;
            const newEntry =
                (pos.qty * pos.entryPrice + fill.qty * fill.price) / newQty;
            return { pos: { ...pos, qty: newQty, entryPrice: newEntry }, realizedPnl };
        }

        // 반대 방향 체결 = 상쇄(청산) + (남으면 반전 오픈)
        const closeQty = Math.min(pos.qty, fill.qty);

        if (pos.side === "LONG") {
            realizedPnl += closeQty * (fill.price - pos.entryPrice);
        } else { // pos.side === "SHORT"
            realizedPnl += closeQty * (pos.entryPrice - fill.price);
        }

        const remainingPosQty = pos.qty - closeQty;
        const remainingFillQty = fill.qty - closeQty;

        if (remainingPosQty > 0) {
            // 포지션 일부만 줄고 방향 유지
            return {
                pos: { ...pos, qty: remainingPosQty },
                realizedPnl
            };
        }

        if (remainingFillQty > 0) {
            // 포지션 반전 오픈 (남은 물량이 새 포지션)
            const newSide = fill.side === "BUY" ? "LONG" : "SHORT";
            return {
                pos: { side: newSide, qty: remainingFillQty, entryPrice: fill.price, status: "OPEN" },
                realizedPnl
            };
        }

        // 완전 청산
        return { pos: { side: "FLAT", qty: 0, entryPrice: 0, status: "CLOSED" }, realizedPnl };
    }

    /**
     * Calculates the unrealized PnL for a position.
     * @param {Position} pos
     * @param {number} markPrice
     * @returns {number}
     */
    function calcUnrealizedPnl(pos, markPrice) {
        if (pos.side === "FLAT" || pos.qty === 0) return 0;
        const diff = markPrice - pos.entryPrice;
        return pos.side === "LONG" ? pos.qty * diff : pos.qty * (-diff);
    }


    // --- RENDER FUNCTIONS ---
    function renderBalance() {
        try {
            if (balanceDisplayEl) {
                balanceDisplayEl.innerText = `Wallet: ${state.user.walletBalance.toFixed(2)} | Avail: ${state.user.availableBalance.toFixed(2)} | Equity: ${state.user.equity.toFixed(2)} USDT`;
            }
        } catch (error) {
            console.error("Error rendering balance:", error);
        }
    }
    
    function renderPrice() {
        try {
            if (currentPriceEl) {
                currentPriceEl.textContent = state.ui.currentPrice.toFixed(2);
                if (state.ui.currentPrice > state.ui.lastPrice) {
                    currentPriceEl.className = 'price-up';
                } else if (state.ui.currentPrice < state.ui.lastPrice) {
                    currentPriceEl.className = 'price-down';
                }
            }
            updateAccountMetrics(); // Metrics depend on current price
            renderOrders(); // Re-render orders as they might be filled
            renderPositions(); // PnL updates with price
        } catch (error) {
            console.error("Error rendering price:", error);
        }
    }

    function renderOrders() {
        try {
            const orders = Object.values(state.orders).filter(o => o.status === 'NEW' || o.status === 'PARTIAL');
            if (!ordersBodyEl) return;

            ordersBodyEl.innerHTML = '';
            if (orders.length === 0) {
                ordersBodyEl.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-secondary);">No open orders.</td></tr>`;
                return;
            }
            orders.forEach(order => {
                const tr = document.createElement('tr');
                const color = order.side === 'BUY' ? 'var(--price-up)' : 'var(--price-down)';
                tr.innerHTML = `
                    <td style="color: ${color}">${order.type} ${order.side}</td>
                    <td>${order.price.toFixed(2)}</td>
                    <td>${order.filledQty}/${order.qty}</td>
                    <td>${order.createdAt.toLocaleTimeString()}</td>
                    <td><button class="cancel-btn" data-id="${order.orderId}">Cancel</button></td>
                `;
                ordersBodyEl.appendChild(tr);
            });
        } catch (error) {
            console.error("Error rendering orders:", error);
        }
    }

    function renderPositions() {
        try {
            const positions = Object.values(state.positions).filter(p => p.status === 'OPEN' && p.qty > 0);
            if (!positionsBodyEl) return;

            positionsBodyEl.innerHTML = '';
            if (positions.length === 0) {
                positionsBodyEl.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-secondary);">No open positions.</td></tr>`; // 5 columns as Liquidation Price removed
                return;
            }
            positions.forEach(pos => {
                // unrealizedPnl is already updated in updateAccountMetrics
                const pnlColor = pos.unrealizedPnl >= 0 ? 'var(--price-up)' : 'var(--price-down)';
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="color: ${pos.side === 'LONG' ? 'var(--price-up)' : 'var(--price-down)'}">${pos.side}</td>
                    <td>${pos.entryPrice.toFixed(2)}</td>
                    <td>${state.ui.currentPrice.toFixed(2)}</td>
                    <td>${pos.qty}</td>
                    <td style="color: ${pnlColor}">${pos.unrealizedPnl.toFixed(2)}</td>
                    <td><button class="close-btn" data-symbol="${pos.symbol}">Close</button></td>
                `;
                positionsBodyEl.appendChild(tr);
            });
        } catch (error) {
            console.error("Error rendering positions:", error);
        }
    }

    function renderAll() {
        console.log('Rendering all UI components...');
        // updateAccountMetrics is called by renderPrice and addToLedger, ensuring latest metrics
        renderBalance();
        renderPrice();
        // renderOrders and renderPositions are called by renderPrice, no need to call twice
    }

    // --- CORE TRADING LOGIC ---
    function placeOrder(side) {
        const type = state.ui.orderType.toUpperCase();
        const price = type === 'MARKET' ? state.ui.currentPrice : parseFloat(priceInput.value);
        const qty = parseFloat(quantityInput.value);
        const symbol = SYMBOL; 

        // --- Client-side Safety Checks (from user's prompt #6) ---
        if (isNaN(qty) || qty <= 0) { alert('Invalid quantity. Must be a positive number.'); return; }
        if (type === 'LIMIT' && (isNaN(price) || price <= 0)) { alert('Invalid price. Must be a positive number for Limit orders.'); return; }
        if (type === 'MARKET' && (isNaN(state.ui.currentPrice) || state.ui.currentPrice <= 0)) { alert('Current market price is invalid. Cannot place Market order.'); return; }
        
        const initialOrderMargin = (price * qty) / LEVERAGE;
        if (initialOrderMargin <= 0) { alert('Calculated order margin is zero or negative. Please check price/quantity.'); return; }
        if (initialOrderMargin > state.user.availableBalance) {
            alert(`Insufficient available balance. Available: ${state.user.availableBalance.toFixed(2)} USDT, Required: ${initialOrderMargin.toFixed(2)} USDT.`);
            return;
        }

        const orderId = state.nextOrderId++;
        const order = {
            orderId, symbol, type, side, qty,
            price: type === 'LIMIT' ? price : state.ui.currentPrice, // Store current price for market orders as a reference for margin
            filledQty: 0,
            status: 'NEW',
            lockedMarginAmount: initialOrderMargin, // Store the exact amount locked for this order
            createdAt: new Date(),
        };
        state.orders[orderId] = order;

        // Reduce availableBalance for the order
        state.user.availableBalance -= order.lockedMarginAmount;
        updateAccountMetrics(); // Update metrics after availableBalance change
        
        console.log(`Placed ${side} ${type} order for ${qty} ${symbol} @ ${order.price.toFixed(2)}. Margin locked: ${order.lockedMarginAmount.toFixed(2)}`);
        
        renderAll();
        if (type === 'LIMIT') priceInput.value = '';
        quantityInput.value = '';
    }

    function cancelOrder(orderId) {
        const order = state.orders[orderId];
        if (!order || order.status !== 'NEW') return;

        order.status = 'CANCELED';
        
        // Return locked margin to availableBalance
        state.user.availableBalance += order.lockedMarginAmount;
        updateAccountMetrics(); // Update metrics after availableBalance change
        
        console.log(`Order ${orderId} canceled. Margin unlocked: ${order.lockedMarginAmount.toFixed(2)}`);
        
        renderAll();
    }
    
    function closePosition(symbol) {
        const position = state.positions[symbol];
        if (!position || position.qty === 0) return;
        
        // Create a market order to close the position
        const orderId = state.nextOrderId++;
        const order = {
            orderId, symbol, type: 'MARKET', side: position.side === 'LONG' ? 'SELL' : 'BUY', qty: position.qty,
            price: state.ui.currentPrice,
            filledQty: 0, status: 'NEW', reduceOnly: true, // reduceOnly is important for backend
            lockedMarginAmount: 0, // Closing orders don't lock new margin from available
            createdAt: new Date(),
        };
        state.orders[orderId] = order;

        console.log(`Placed market order ${orderId} to close ${symbol} position.`);
        renderOrders(); // Only render orders for now, will be filled in next cycle
    }

    function tryFillOrders() {
        Object.values(state.orders).forEach(order => {
            if (order.status !== 'NEW') return;
            
            const shouldFill = (order.type === 'MARKET') ||
                               (order.side === 'BUY' && state.ui.currentPrice <= order.price) ||
                               (order.side === 'SELL' && state.ui.currentPrice >= order.price);
            
            if (shouldFill) {
                const fillPrice = order.type === 'MARKET' ? state.ui.currentPrice : order.price;
                
                order.status = 'FILLED';
                order.filledQty = order.qty;

                // Return locked margin for this order to availableBalance (it was consumed by fill)
                // Note: In a real system, availableBalance would be managed on server with ledger.
                state.user.availableBalance += order.lockedMarginAmount;

                // --- Apply fill to position ---
                const currentPosition = state.positions[order.symbol] || { side: "FLAT", qty: 0, entryPrice: 0, status: "CLOSED" };
                const fill = { side: /** @type {Side} */(order.side), qty: order.qty, price: fillPrice }; // Type assertion

                const { pos: updatedPosition, realizedPnl } = applyFillNet(currentPosition, fill);

                // --- Handle Realized PnL ---
                if (realizedPnl !== 0) {
                    addToLedger('REALIZED_PNL', realizedPnl, { orderId: order.orderId, tradeId: state.nextTradeId++, symbol: order.symbol });
                }

                // --- Handle Fees ---
                const fee = (fillPrice * order.qty) * FEE_RATE; 
                addToLedger('FEE', -fee, { orderId: order.orderId, tradeId: state.nextTradeId++, symbol: order.symbol });

                // --- Update Position State ---
                if (updatedPosition.qty === 0 || updatedPosition.side === "FLAT") {
                    delete state.positions[order.symbol]; // Position fully closed
                } else {
                    state.positions[order.symbol] = {
                        ...updatedPosition,
                        symbol: order.symbol,
                        leverage: LEVERAGE, // Maintain leverage for display/rule
                        marginMode: 'CROSS',
                        status: 'OPEN',
                        updatedAt: new Date(),
                    };
                }
                
                console.log(`Order ${order.orderId} filled. New position: ${updatedPosition.side} ${updatedPosition.qty} @ ${updatedPosition.entryPrice.toFixed(2)}. Realized PnL: ${realizedPnl.toFixed(2)}`);
            }
        });
    }

    function checkLiquidation() {
        // Cross liquidation trigger: equity <= maintenanceMarginTotal
        // Only check if there are open positions and user is not already liquidated (equity > 0)
        if (Object.keys(state.positions).length > 0 && state.user.equity > 0 && state.user.equity <= state.user.maintenanceMarginTotal) {
            console.warn(`ACCOUNT LIQUIDATED! Equity: ${state.user.equity.toFixed(2)}, Maintenance Margin Total: ${state.user.maintenanceMarginTotal.toFixed(2)}`);
            
            // The actual capital lost on liquidation
            const liquidationLossAmount = state.user.walletBalance; // Simplified: entire wallet balance is lost

            // Clear all positions
            Object.values(state.positions).forEach(pos => {
                // For each liquidated position, record its PnL as realized
                let unrealizedPnlAtLiquidation;
                if (pos.side === 'LONG') {
                    unrealizedPnlAtLiquidation = pos.qty * (state.ui.currentPrice - pos.entryPrice);
                } else {
                    unrealizedPnlAtLiquidation = pos.qty * (pos.entryPrice - state.ui.currentPrice);
                }
                addToLedger('REALIZED_PNL', unrealizedPnlAtLiquidation, { symbol: pos.symbol, type: 'liquidation' });
                // Any specific liquidation fee would also be added here
                // For MVP, total walletBalance is considered lost and reset to 0 in UI below.
                // In a real system, the exact loss amount would be calculated more precisely based on account equity vs zero.
            });
            
            state.positions = {}; // All positions gone
            
            // Deduct the total wallet balance as a single liquidation fee
            addToLedger('LIQUIDATION_FEE', -liquidationLossAmount, { uid: state.user.uid, description: "Account full liquidation" });

            // Reset user metrics after liquidation
            state.user.walletBalance = 0;
            state.user.availableBalance = 0;
            state.user.unrealizedPnlTotal = 0;
            state.user.maintenanceMarginTotal = 0;
            state.user.equity = 0;
            
            alert('Your account has been liquidated!');
        }
    }


    // --- EVENT LISTENERS ---
    tabs.forEach(tab => {
        if (tab) { 
            tab.addEventListener('click', (e) => {
                tabs.forEach(t => t.classList.remove('active'));
                e.target.classList.add('active');
                state.ui.orderType = e.target.dataset.orderType;
                if (limitOrderInputs) { 
                    limitOrderInputs.style.display = state.ui.orderType === 'limit' ? 'block' : 'none';
                }
            });
        }
    });
    
    if (buyBtn) buyBtn.addEventListener('click', () => placeOrder('BUY'));
    if (sellBtn) sellBtn.addEventListener('click', () => placeOrder('SELL'));

    if (ordersBodyEl) {
        ordersBodyEl.addEventListener('click', (e) => {
            if (e.target.classList.contains('cancel-btn')) {
                cancelOrder(parseInt(e.target.dataset.id, 10));
            }
        });
    }

    if (positionsBodyEl) {
        positionsBodyEl.addEventListener('click', (e) => {
            if (e.target.classList.contains('close-btn')) {
                closePosition(e.target.dataset.symbol);
            }
        });
    }

    // --- SIMULATION ---
    function startSimulation() {
        setInterval(() => {
            state.ui.lastPrice = state.ui.currentPrice;
            const change = (Math.random() - 0.5) * 50; 
            state.ui.currentPrice += change;
            if(state.ui.currentPrice <= 0) state.ui.currentPrice = 100;
            
            tryFillOrders();
            checkLiquidation(); 
            renderPrice(); // This calls updateAccountMetrics, renderOrders and renderPositions
        }, 1500);
    }

    // --- INITIALIZATION ---
    updateAccountMetrics(); // Initial calculation of equity/available
    renderAll();
    startSimulation();
    console.log('Script initialized and simulation started.');
});