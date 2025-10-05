// EV Charger Contract Integration
// Based on operator.html logic and aci.json

const { AeSdkAepp, Node, BrowserWindowMessageConnection, walletDetector, Contract } = window.Aeternity;

// Contract configuration
const EV_CONTRACT_ADDRESS = 'ct_gWCgyfWtVYAYXD2zwPQHxLK6btmvjhPhZE9XVmSzpaVNVPjb7';
const TESTNET_NODE_URL = 'https://testnet.aeternity.io';
const COMPILER_URL = 'https://compiler.aepps.com';

class EVChargerManager {
    constructor() {
        this.aeSdk = null;
        this.contract = null;
        this.connected = false;
        this.currentAddress = null;
        this.aci = null;
    }

    async init() {
        console.log('🚀 Initializing EV Charger Manager...');
        
        // Load ACI
        try {
            const response = await fetch('./aci.json');
            this.aci = await response.json();
            console.log('✅ ACI loaded successfully');
        } catch (error) {
            console.error('❌ Failed to load ACI:', error);
            throw error;
        }
    }

    async connectWallet() {
        if (!this.aeSdk) {
            this.aeSdk = new AeSdkAepp({
                name: 'Dobi EV Charger',
                nodes: [{ name: 'testnet', instance: new Node(TESTNET_NODE_URL) }],
                compilerUrl: COMPILER_URL,
                onAddressChange: ({ current }) => {
                    const addr = Object.keys(current)[0];
                    this.currentAddress = addr;
                    this.updateWalletUI(addr);
                },
                onDisconnect: () => {
                    this.connected = false;
                    this.currentAddress = null;
                    this.updateWalletUI(null);
                }
            });
        }

        const scanner = new BrowserWindowMessageConnection();
        let stopped = false;
        
        const handleWallets = async ({ wallets, newWallet }) => {
            if (stopped) return;
            const wallet = newWallet || Object.values(wallets)[0];
            stopped = true;
            
            try {
                await this.aeSdk.connectToWallet(wallet.getConnection(), { 
                    connectNode: true, 
                    name: 'wallet-node', 
                    select: true 
                });
                
                await new Promise(r => setTimeout(r, 150));
                
                const { address: { current } } = await this.aeSdk.subscribeAddress('subscribe', 'connected');
                const addr = Object.keys(current)[0];
                this.currentAddress = addr;
                this.connected = true;
                
                this.updateWalletUI(addr);
                await this.initContract();
                
                console.log('✅ Wallet connected successfully');
                return true;
            } catch (error) {
                console.error('❌ Wallet connection failed:', error);
                throw error;
            }
        };
        
        const stopScan = walletDetector(scanner, handleWallets);
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                if (!this.connected) {
                    reject(new Error('Connection timeout'));
                } else {
                    resolve(true);
                }
            }, 10000);
        });
    }

    async initContract() {
        if (!this.aeSdk || !this.aci) {
            throw new Error('SDK or ACI not initialized');
        }

        try {
            this.contract = await Contract.initialize({
                aci: this.aci,
                address: EV_CONTRACT_ADDRESS,
                client: this.aeSdk
            });
            
            console.log('✅ Contract initialized successfully');
        } catch (error) {
            console.error('❌ Contract initialization failed:', error);
            throw error;
        }
    }

    updateWalletUI(address) {
        const walletText = document.getElementById('wallet-text');
        const walletBalance = document.getElementById('wallet-balance');
        const summaryOwner = document.getElementById('summary-owner');
        
        if (address) {
            if (walletText) walletText.textContent = shortAddress(address);
            if (summaryOwner) summaryOwner.textContent = address;
            this.updateBalance();
        } else {
            if (walletText) walletText.textContent = 'Connect Wallet';
            if (walletBalance) walletBalance.textContent = '0 AE';
            if (summaryOwner) summaryOwner.textContent = '-';
        }
    }

    async updateBalance() {
        if (!this.aeSdk || !this.currentAddress) return;
        
        try {
            const balance = await this.aeSdk.getBalance(this.currentAddress);
            const aeBalance = (balance / 1000000000000000000).toFixed(4);
            
            const walletBalance = document.getElementById('wallet-balance');
            const summaryWalletAe = document.getElementById('summary-wallet-ae');
            
            if (walletBalance) walletBalance.textContent = `${aeBalance} AE`;
            if (summaryWalletAe) summaryWalletAe.textContent = `${aeBalance} AE`;
        } catch (error) {
            console.error('Failed to update balance:', error);
        }
    }

    // EV Charger specific methods
    async registerCharger(chargerId, location, initialBalance) {
        if (!this.contract) throw new Error('Contract not initialized');
        
        try {
            const result = await this.contract.register_charger(chargerId, location, initialBalance);
            console.log('✅ Charger registered:', result);
            return result;
        } catch (error) {
            console.error('❌ Failed to register charger:', error);
            throw error;
        }
    }

    async getChargerInfo(chargerId) {
        if (!this.contract) throw new Error('Contract not initialized');
        
        try {
            const result = await this.contract.get_charger_info(chargerId);
            return result.decodedResult;
        } catch (error) {
            console.error('❌ Failed to get charger info:', error);
            throw error;
        }
    }

    async getChargerBalance(chargerId) {
        if (!this.contract) throw new Error('Contract not initialized');
        
        try {
            const result = await this.contract.get_charger_balance(chargerId);
            return result.decodedResult;
        } catch (error) {
            console.error('❌ Failed to get charger balance:', error);
            throw error;
        }
    }

    async fundCharger(chargerId, amount) {
        if (!this.contract) throw new Error('Contract not initialized');
        
        try {
            const result = await this.contract.fund_charger(chargerId, { amount });
            console.log('✅ Charger funded:', result);
            return result;
        } catch (error) {
            console.error('❌ Failed to fund charger:', error);
            throw error;
        }
    }

    async registerProvider(providerId, name, pricePerKwh) {
        if (!this.contract) throw new Error('Contract not initialized');
        
        try {
            const result = await this.contract.register_provider(providerId, name, pricePerKwh);
            console.log('✅ Provider registered:', result);
            return result;
        } catch (error) {
            console.error('❌ Failed to register provider:', error);
            throw error;
        }
    }

    async getProviderInfo(providerId) {
        if (!this.contract) throw new Error('Contract not initialized');
        
        try {
            const result = await this.contract.get_provider_info(providerId);
            return result.decodedResult;
        } catch (error) {
            console.error('❌ Failed to get provider info:', error);
            throw error;
        }
    }

    async startConsumption(chargerId, providerId, oracleId, estimatedKwh, metadata) {
        if (!this.contract) throw new Error('Contract not initialized');
        
        try {
            const result = await this.contract.start_consumption(chargerId, providerId, oracleId, estimatedKwh, metadata);
            console.log('✅ Consumption started:', result);
            return result.decodedResult;
        } catch (error) {
            console.error('❌ Failed to start consumption:', error);
            throw error;
        }
    }

    async updateConsumptionReading(sessionId, kwhReading) {
        if (!this.contract) throw new Error('Contract not initialized');
        
        try {
            const result = await this.contract.update_consumption_reading(sessionId, kwhReading);
            console.log('✅ Consumption updated:', result);
            return result;
        } catch (error) {
            console.error('❌ Failed to update consumption:', error);
            throw error;
        }
    }

    async stopConsumption(sessionId, finalKwh) {
        if (!this.contract) throw new Error('Contract not initialized');
        
        try {
            const result = await this.contract.stop_consumption(sessionId, finalKwh);
            console.log('✅ Consumption stopped:', result);
            return result;
        } catch (error) {
            console.error('❌ Failed to stop consumption:', error);
            throw error;
        }
    }

    async getSession(sessionId) {
        if (!this.contract) throw new Error('Contract not initialized');
        
        try {
            const result = await this.contract.get_session(sessionId);
            return result.decodedResult;
        } catch (error) {
            console.error('❌ Failed to get session:', error);
            throw error;
        }
    }

    // UI Helper methods
    async loadChargerData(chargerId) {
        try {
            const balance = await this.getChargerBalance(chargerId);
            const info = await this.getChargerInfo(chargerId);
            
            // Update UI elements
            const balanceEl = document.getElementById('charger-balance');
            const totalKwhEl = document.getElementById('total-kwh-consumed');
            const totalRevenueEl = document.getElementById('total-revenue');
            
            if (balanceEl) balanceEl.textContent = `${balance} aettos`;
            if (info && totalKwhEl) totalKwhEl.textContent = `${info.total_kwh_consumed || 0} kWh`;
            if (info && totalRevenueEl) totalRevenueEl.textContent = `${(info.total_paid || 0) / 1000000000000000000} AE`;
            
            return { balance, info };
        } catch (error) {
            console.error('Failed to load charger data:', error);
            throw error;
        }
    }

    // Load and display electricity providers
    async loadProviders() {
        try {
            // For now, we'll create some mock providers since the contract doesn't have a list function
            const mockProviders = [
                { id: 'PROVIDER_1', name: 'Green Energy Co.', price: 0.12 },
                { id: 'PROVIDER_2', name: 'Solar Power Ltd.', price: 0.15 },
                { id: 'PROVIDER_3', name: 'Wind Energy Inc.', price: 0.10 }
            ];
            
            const container = document.getElementById('providers-list');
            if (!container) return;
            
            container.innerHTML = '';
            
            mockProviders.forEach(provider => {
                const providerBtn = document.createElement('button');
                providerBtn.className = 'provider-btn w-full bg-blue-100 hover:bg-blue-200 rounded-lg p-3 mb-2 text-left transition-colors';
                providerBtn.innerHTML = `
                    <div class="flex justify-between items-center">
                        <div>
                            <p class="font-bold text-blue-800">${provider.name}</p>
                            <p class="text-sm text-blue-600">${provider.price} AE/kWh</p>
                        </div>
                        <i class="fas fa-arrow-right text-blue-600"></i>
                    </div>
                `;
                providerBtn.onclick = () => this.startConsumptionWithProvider(provider);
                container.appendChild(providerBtn);
            });
            
        } catch (error) {
            console.error('Failed to load providers:', error);
            const container = document.getElementById('providers-list');
            if (container) {
                container.innerHTML = '<p class="text-red-500 text-center py-4">Failed to load providers</p>';
            }
        }
    }

    // Start consumption session with selected provider
    async startConsumptionWithProvider(provider) {
        if (!this.contract || !this.currentAddress || !this.connected) {
            this.showToast('Please connect wallet first', 'error');
            return;
        }
        
        try {
            const chargerId = this.getCurrentChargerId();
            if (!chargerId) {
                this.showToast('No charger selected', 'error');
                return;
            }
            
            // Create a mock oracle ID (in real implementation, this would be a real oracle)
            const oracleId = `ok_${this.currentAddress.slice(2)}`;
            const estimatedKwh = 10; // Default estimated kWh
            const metadata = JSON.stringify({
                vehicle_model: 'Tesla Model 3',
                battery_capacity: 75,
                requested_by: 'Dobi AI Agent'
            });
            
            const sessionId = await this.startConsumption(
                chargerId, 
                provider.id, 
                oracleId, 
                estimatedKwh, 
                metadata
            );
            
            this.activeSession = {
                id: sessionId,
                provider: provider,
                startTime: Date.now(),
                kwhUsed: 0,
                totalCost: 0
            };
            
            this.showActiveSession();
            this.startSessionMonitoring();
            
            this.showToast(`Charging session started with ${provider.name}`, 'success');
            this.addBlockchainEvent('Session Started', `Session #${sessionId}`, 'success');
            
        } catch (error) {
            console.error('Failed to start consumption:', error);
            this.showToast('Failed to start charging session: ' + error.message, 'error');
        }
    }

    // Show active session UI
    showActiveSession() {
        const activeConsumption = document.getElementById('active-consumption');
        const noActiveSession = document.getElementById('no-active-session');
        
        if (activeConsumption) activeConsumption.style.display = 'block';
        if (noActiveSession) noActiveSession.style.display = 'none';
        
        if (this.activeSession) {
            const activeProvider = document.getElementById('active-provider');
            const activeSessionId = document.getElementById('active-session-id');
            
            if (activeProvider) activeProvider.textContent = this.activeSession.provider.name;
            if (activeSessionId) activeSessionId.textContent = `#${this.activeSession.id}`;
        }
    }

    // Hide active session UI
    hideActiveSession() {
        const activeConsumption = document.getElementById('active-consumption');
        const noActiveSession = document.getElementById('no-active-session');
        
        if (activeConsumption) activeConsumption.style.display = 'none';
        if (noActiveSession) noActiveSession.style.display = 'block';
    }

    // Start monitoring active session
    startSessionMonitoring() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        
        this.updateInterval = setInterval(() => {
            this.updateActiveSession();
        }, 15000); // Update every 15 seconds
    }

    // Stop session monitoring
    stopSessionMonitoring() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    // Update active session data
    async updateActiveSession() {
        if (!this.activeSession) return;
        
        try {
            // Simulate consumption increase (in real implementation, this would come from IoT device)
            const consumptionIncrease = Math.random() * 0.5; // 0-0.5 kWh
            this.activeSession.kwhUsed += consumptionIncrease;
            this.activeSession.totalCost = this.activeSession.kwhUsed * this.activeSession.provider.price;
            
            // Update UI
            const activeKwh = document.getElementById('active-kwh');
            const activeCost = document.getElementById('active-cost');
            const activeRate = document.getElementById('active-rate');
            const elapsedTime = document.getElementById('elapsed-time');
            
            if (activeKwh) activeKwh.textContent = this.activeSession.kwhUsed.toFixed(2);
            if (activeCost) activeCost.textContent = this.activeSession.totalCost.toFixed(4);
            if (activeRate) activeRate.textContent = this.activeSession.provider.price;
            if (elapsedTime) {
                const elapsed = Math.floor((Date.now() - this.activeSession.startTime) / 1000);
                elapsedTime.textContent = `${elapsed} seconds`;
            }
            
            // Update blockchain (simulate)
            await this.updateConsumptionReading(this.activeSession.id, Math.floor(this.activeSession.kwhUsed * 1000));
            
        } catch (error) {
            console.error('Failed to update active session:', error);
        }
    }

    // Stop charging session
    async stopChargingSession() {
        if (!this.activeSession) return;
        
        try {
            const finalKwh = Math.floor(this.activeSession.kwhUsed * 1000); // Convert to aettos
            await this.stopConsumption(this.activeSession.id, finalKwh);
            
            this.addBlockchainEvent('Session Stopped', `Session #${this.activeSession.id}`, 'success');
            this.showToast('Charging session stopped successfully', 'success');
            
            this.activeSession = null;
            this.stopSessionMonitoring();
            this.hideActiveSession();
            
            // Reload charger data
            const chargerId = this.getCurrentChargerId();
            if (chargerId) {
                await this.loadChargerData(chargerId);
            }
            
        } catch (error) {
            console.error('Failed to stop charging session:', error);
            this.showToast('Failed to stop charging session: ' + error.message, 'error');
        }
    }

    // Add blockchain event to UI
    addBlockchainEvent(title, txHash, type) {
        const container = document.getElementById('blockchain-events');
        if (!container) return;
        
        // Remove "no transactions" message if present
        const noTxMsg = container.querySelector('.text-gray-500');
        if (noTxMsg) noTxMsg.remove();
        
        const colors = {
            success: 'bg-green-50 border-green-200 text-green-800',
            payment: 'bg-purple-50 border-purple-200 text-purple-800',
            info: 'bg-blue-50 border-blue-200 text-blue-800'
        };
        
        const event = document.createElement('div');
        event.className = `${colors[type] || colors.info} border rounded-lg p-3 text-sm mb-2`;
        event.innerHTML = `
            <p class="font-bold">${title}</p>
            <p class="text-xs break-all">${txHash}</p>
            <p class="text-xs mt-1">${new Date().toLocaleTimeString()}</p>
        `;
        
        container.insertBefore(event, container.firstChild);
        
        // Keep only last 10 events
        while (container.children.length > 10) {
            container.removeChild(container.lastChild);
        }
    }

    // Get current charger ID from device context
    getCurrentChargerId() {
        // This should be set when showing device details
        return this.currentChargerId || 'CHARGER_001';
    }

    // Set current charger ID
    setCurrentChargerId(chargerId) {
        this.currentChargerId = chargerId;
    }

    // Show toast notification
    showToast(message, type = 'info') {
        // Use the existing toast system from app.js if available
        if (window.showToast) {
            window.showToast(message, type);
        } else {
            console.log(`[${type.toUpperCase()}] ${message}`);
        }
    }

    showChargerManagement() {
        const evChargerManagement = document.getElementById('ev-charger-management');
        if (evChargerManagement) {
            evChargerManagement.style.display = 'block';
        }
    }

    hideChargerManagement() {
        const evChargerManagement = document.getElementById('ev-charger-management');
        if (evChargerManagement) {
            evChargerManagement.style.display = 'none';
        }
    }
}

// Helper function
function shortAddress(address) {
    if (!address) return '';
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Export for use in main app
window.EVChargerManager = EVChargerManager;
