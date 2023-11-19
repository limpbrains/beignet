import {
	EAddressType,
	EAvailableNetworks,
	IAddress,
	IAddresses,
	TAddressTypeContent,
	TConnectToElectrumRes,
	IElectrumGetAddressBalanceRes,
	IGetAddressHistoryResponse,
	IGetAddressScriptHashesHistoryResponse,
	IGetHeaderResponse,
	IGetTransactions,
	IGetTransactionsFromInputs,
	IGetUtxosResponse,
	IHeader,
	INewBlock,
	ISubscribeToAddress,
	ISubscribeToHeader,
	ITransaction,
	ITxHash,
	IUtxo,
	TElectrumNetworks,
	TMessageKeys,
	TServer,
	TSubscribedReceive,
	TTxResponse,
	TTxResult,
	TUnspentAddressScriptHashData,
	IPeerData,
	TGetAddressHistory,
	TOnMessage
} from '../types';
import * as electrum from 'rn-electrum-client/helpers';
import { err, getAddressFromScriptPubKey, ok, Result } from '../utils';
import { Wallet } from '../wallet';
import { CHUNK_LIMIT, GAP_LIMIT } from '../wallet/constants';
import { getScriptHash, objectKeys } from '../utils';
import { addressTypes, POLLING_INTERVAL } from '../shapes';
import { Block } from 'bitcoinjs-lib';
import { onMessageKeys } from '../shapes';
import { Server } from 'net';
import { TLSSocket } from 'tls';

let tls, net;
try {
	tls = require('tls');
	net = require('net');
} catch {
	// Modules not available, will attempt to use passed instances, if any.
}

export class Electrum {
	private readonly _wallet: Wallet;
	private onMessage: TOnMessage;
	private latestConnectionState: boolean | null = null;
	private connectionPollingInterval: NodeJS.Timeout | null;

	public servers?: TServer | TServer[];
	public readonly network: EAvailableNetworks;
	public readonly electrumNetwork: TElectrumNetworks;
	public connectedToElectrum: boolean;
	public onReceive?: (data: unknown) => void;
	public onElectrumConnectionChange?: (isConnected: boolean) => void;
	constructor({
		wallet,
		servers,
		network,
		onReceive,
		tls: _tls,
		net: _net
	}: {
		wallet: Wallet;
		servers?: TServer | TServer[];
		network: EAvailableNetworks;
		onReceive?: (data: unknown) => void;
		tls?: TLSSocket;
		net?: Server;
	}) {
		this._wallet = wallet;
		this.onMessage = wallet?.onMessage ?? ((): null => null);
		this.servers = servers ?? [];
		this.network = network;
		this.electrumNetwork = this.getElectrumNetwork(network);
		this.connectedToElectrum = false;
		this.onReceive = onReceive;
		if (!tls) tls = _tls;
		if (!net) net = _net;
		if (!tls || !net) {
			throw new Error(
				'TLS and NET modules are not available and were not passed as instances'
			);
		}
		this.connectionPollingInterval = setInterval(
			(): Promise<void> => this.checkConnection(),
			POLLING_INTERVAL
		);
	}

	public get wallet(): Wallet {
		return this._wallet;
	}

	async connectToElectrum({
		network = this.network,
		servers
	}: {
		network?: EAvailableNetworks;
		servers?: TServer | TServer[];
	}): Promise<Result<TConnectToElectrumRes>> {
		let customPeers = servers
			? Array.isArray(servers)
				? servers
				: [servers]
			: [];
		// @ts-ignore
		customPeers = customPeers.length ? customPeers : this?.servers ?? [];
		const electrumNetwork = this.getElectrumNetwork(network);
		if (electrumNetwork === 'bitcoinRegtest' && !customPeers.length) {
			return err('Regtest requires that you pre-specify a server.');
		}
		const startResponse = await electrum.start({
			network: electrumNetwork,
			tls,
			net,
			customPeers
		});
		if (startResponse.error) return err(startResponse.error);
		await this.subscribeToHeader();
		this.publishConnectionChange(true);
		return ok('Connected to Electrum server.');
	}

	async isConnected(): Promise<boolean> {
		const { error } = await electrum.pingServer();
		return !error;
	}

	/**
	 * Returns the balance in sats for a given address.
	 * @param {string} scriptHash
	 * @return {number}
	 */
	async getAddressBalance(
		scriptHash: string
	): Promise<IElectrumGetAddressBalanceRes> {
		if (!this.connectedToElectrum)
			await this.connectToElectrum({
				network: this.network,
				servers: this.servers
			});
		const network = this.electrumNetwork;
		const response = await electrum.getAddressScriptHashBalance({
			scriptHash,
			network
		});
		if (response.error) {
			return { error: response.error, confirmed: 0, unconfirmed: 0 };
		}
		const { confirmed, unconfirmed } = response.data;
		return { error: response.error, confirmed, unconfirmed };
	}

	async getAddressScriptHashBalances(scriptHashes: string[]): Promise<any> {
		return await electrum.getAddressScriptHashBalances({
			scriptHashes,
			network: this.electrumNetwork
		});
	}

	/**
	 * Returns currently connected peer.
	 * @returns {Promise<Result<IPeerData>>}
	 */
	async getConnectedPeer(): Promise<Result<IPeerData>> {
		const response = await electrum.getConnectedPeer(this.electrumNetwork);
		if (response?.host && response?.port && response?.protocol) {
			return ok(response);
		}
		return err('No peer available.');
	}

	/**
	 * Returns the network string for use with Electrum methods.
	 * @param {EAvailableNetworks} [network]
	 * @return {TElectrumNetworks}
	 */
	getElectrumNetwork(network: EAvailableNetworks): TElectrumNetworks {
		switch (network) {
			case 'bitcoin':
				return 'bitcoin';
			case 'testnet':
				return 'bitcoinTestnet';
			case 'regtest':
				return 'bitcoinRegtest';
			default:
				return 'bitcoinTestnet';
		}
	}

	/**
	 * Queries Electrum to return the available UTXO's and balance of the provided addresses.
	 * @param {EAvailableNetworks} [selectedNetwork]
	 * @param {TUnspentAddressScriptHashData} addresses
	 */
	async listUnspentAddressScriptHashes({
		addresses
	}: {
		addresses: TUnspentAddressScriptHashData;
	}): Promise<Result<IGetUtxosResponse>> {
		try {
			const unspentAddressResult =
				await electrum.listUnspentAddressScriptHashes({
					scriptHashes: {
						key: 'scriptHash',
						data: addresses
					},
					network: this.electrumNetwork
				});
			if (unspentAddressResult.error) {
				return err(unspentAddressResult.error);
			}
			let balance = 0;
			const utxos: IUtxo[] = [];
			unspentAddressResult.data.map(({ data, result }) => {
				if (result?.length > 0) {
					return result.map((unspentAddress: IUtxo) => {
						balance = balance + unspentAddress.value;
						utxos.push({
							...data,
							...unspentAddress
						});
					});
				}
			});
			return ok({ utxos, balance });
		} catch (e) {
			return err(e);
		}
	}

	/**
	 * Returns the available history for the provided address script hashes.
	 * @param {IAddress[]} [scriptHashes]
	 * @param {boolean} [scanAllAddresses]
	 * @returns {Promise<Result<IGetAddressHistoryResponse[]>>}
	 */
	async getAddressHistory({
		scriptHashes = [],
		scanAllAddresses = false
	}: {
		scriptHashes?: IAddress[];
		scanAllAddresses?: boolean;
	}): Promise<Result<IGetAddressHistoryResponse[]>> {
		try {
			if (!this.connectedToElectrum)
				await this.connectToElectrum({
					network: this.network,
					servers: this.servers
				});
			const currentWallet = this._wallet.data;
			const currentAddresses: TAddressTypeContent<IAddresses> =
				currentWallet.addresses;
			const currentChangeAddresses: TAddressTypeContent<IAddresses> =
				currentWallet.changeAddresses;

			const addressIndexes = currentWallet.addressIndex;
			const changeAddressIndexes = currentWallet.changeAddressIndex;

			if (scriptHashes.length < 1) {
				const addressTypeKeys = objectKeys(addressTypes);
				addressTypeKeys.forEach((addressType) => {
					const addresses = currentAddresses[addressType];
					const changeAddresses = currentChangeAddresses[addressType];
					let addressValues = Object.values(addresses);
					let changeAddressValues = Object.values(changeAddresses);

					const addressIndex = addressIndexes[addressType].index;
					const changeAddressIndex = changeAddressIndexes[addressType].index;

					// Instead of scanning all addresses, adhere to the gap limit.
					if (
						!scanAllAddresses &&
						addressIndex >= 0 &&
						changeAddressIndex >= 0
					) {
						addressValues = addressValues.filter(
							(a) => Math.abs(addressIndex - a.index) <= GAP_LIMIT
						);
						changeAddressValues = changeAddressValues.filter(
							(a) => Math.abs(changeAddressIndex - a.index) <= GAP_LIMIT
						);
					}

					scriptHashes = [
						...scriptHashes,
						...addressValues,
						...changeAddressValues
					];
				});
			}
			// remove items with same path
			scriptHashes = scriptHashes.filter((sh, index, arr) => {
				return index === arr.findIndex((v) => sh.path === v.path);
			});
			if (scriptHashes.length < 1) {
				return err('No scriptHashes available to check.');
			}

			const combinedResponse: TTxResponse[] = [];

			// split payload in chunks of 10 addresses per-request
			for (let i = 0; i < scriptHashes.length; i += CHUNK_LIMIT) {
				const chunk = scriptHashes.slice(i, i + CHUNK_LIMIT);
				const payload = {
					key: 'scriptHash',
					data: chunk
				};

				const response: IGetAddressScriptHashesHistoryResponse =
					await electrum.getAddressScriptHashesHistory({
						scriptHashes: payload,
						network: this.electrumNetwork
					});

				const mempoolResponse: IGetAddressScriptHashesHistoryResponse =
					await electrum.getAddressScriptHashesMempool({
						scriptHashes: payload,
						network: this.electrumNetwork
					});

				if (response.error || mempoolResponse.error) {
					return err('Unable to get address history.');
				}
				combinedResponse.push(...response.data, ...mempoolResponse.data);
			}

			const history: IGetAddressHistoryResponse[] = [];
			combinedResponse.forEach(
				({ data, result }: { data: IAddress; result: TTxResult[] }): void => {
					if (result && result?.length > 0) {
						result.forEach((item) => {
							history.push({ ...data, ...item });
						});
					}
				}
			);
			return ok(history);
		} catch (e) {
			return err(e);
		}
	}

	/**
	 * Used to retrieve scriptPubkey history for LDK.
	 * @param {string} scriptPubkey
	 * @returns {Promise<TGetAddressHistory[]>}
	 */
	async getScriptPubKeyHistory(
		scriptPubkey: string
	): Promise<TGetAddressHistory[]> {
		const history: { txid: string; height: number }[] = [];
		const address = getAddressFromScriptPubKey(scriptPubkey, this.network);
		if (!address) {
			return history;
		}
		const scriptHash = getScriptHash({
			network: this.network,
			address
		});
		if (!scriptHash) {
			return history;
		}
		const response = await electrum.getAddressScriptHashesHistory({
			scriptHashes: [scriptHash],
			network: this.electrumNetwork
		});
		if (response.error) {
			return history;
		}
		await Promise.all(
			response.data.map(({ result }): void => {
				if (result && result?.length > 0) {
					result.map((item) => {
						history.push({
							txid: item?.tx_hash ?? '',
							height: item?.height ?? 0
						});
					});
				}
			})
		);
		return history;
	}

	/**
	 * Returns UTXO's for a given wallet and network along with the available balance.
	 * @param {boolean} [scanAllAddresses]
	 * @returns {Promise<Result<IGetUtxosResponse>>}
	 */
	async getUtxos({
		scanAllAddresses = false
	}: {
		scanAllAddresses?: boolean;
	}): Promise<Result<IGetUtxosResponse>> {
		try {
			if (!this.connectedToElectrum)
				await this.connectToElectrum({
					network: this.network,
					servers: this.servers
				});
			const currentWallet = this._wallet.data;

			const addressTypeKeys = Object.values(EAddressType);
			let addresses = {} as IAddresses;
			let changeAddresses = {} as IAddresses;
			const existingUtxos: { [key: string]: IUtxo } = {};

			for (const addressType of addressTypeKeys) {
				const addressCount = Object.keys(currentWallet.addresses[addressType])
					?.length;

				// Check if addresses of this type have been generated. If not, skip.
				if (addressCount <= 0) {
					break;
				}

				// Grab the current index for both addresses and change addresses.
				const addressIndex = currentWallet.addressIndex[addressType].index;
				const changeAddressIndex =
					currentWallet.changeAddressIndex[addressType].index;

				// Grab all addresses and change addresses.
				const allAddresses = currentWallet.addresses[addressType];
				const allChangeAddresses = currentWallet.changeAddresses[addressType];

				// Instead of scanning all addresses, adhere to the gap limit.
				if (!scanAllAddresses && addressIndex >= 0 && changeAddressIndex >= 0) {
					Object.values(allAddresses).map((a) => {
						if (Math.abs(a.index - addressIndex) <= GAP_LIMIT) {
							addresses[a.scriptHash] = a;
						}
					});
					Object.values(allChangeAddresses).map((a) => {
						if (Math.abs(a.index - changeAddressIndex) <= GAP_LIMIT) {
							changeAddresses[a.scriptHash] = a;
						}
					});
				} else {
					addresses = { ...addresses, ...allAddresses };
					changeAddresses = { ...changeAddresses, ...allChangeAddresses };
				}
			}

			// Make sure we're re-check existing utxos that may exist outside the gap limit and putting them in the necessary format.
			currentWallet.utxos.map((utxo) => {
				existingUtxos[utxo.scriptHash] = utxo;
			});

			const data: TUnspentAddressScriptHashData = {
				...addresses,
				...changeAddresses,
				...existingUtxos
			};

			return this.listUnspentAddressScriptHashes({ addresses: data });
		} catch (e) {
			return err(e);
		}
	}

	/**
	 * Returns available transactions from electrum based on the provided txHashes.
	 * @param {ITxHash[]} txHashes
	 * @return {Promise<Result<IGetTransactions>>}
	 */
	async getTransactions({
		txHashes = []
	}: {
		txHashes: ITxHash[];
	}): Promise<Result<IGetTransactions>> {
		try {
			if (txHashes.length < 1) {
				return ok({
					error: false,
					id: 0,
					method: 'getTransactions',
					network: this.electrumNetwork,
					data: []
				});
			}

			const result: ITransaction<IUtxo>[] = [];

			// split payload in chunks of 10 transactions per-request
			for (let i = 0; i < txHashes.length; i += CHUNK_LIMIT) {
				const chunk = txHashes.slice(i, i + CHUNK_LIMIT);

				const data = {
					key: 'tx_hash',
					data: chunk
				};
				const response = await electrum.getTransactions({
					txHashes: data,
					network: this.electrumNetwork
				});
				if (response.error) {
					return err(response);
				}
				result.push(...response.data);
			}
			return ok({
				error: false,
				id: 0,
				method: 'getTransactions',
				network: this.electrumNetwork,
				data: result
			});
		} catch (e) {
			return err(e);
		}
	}

	/**
	 * Determines whether a transaction exists based on the transaction response from electrum.
	 * @param {ITransaction<IUtxo>} txData
	 * @returns {boolean}
	 */
	public transactionExists(txData: ITransaction<IUtxo>): boolean {
		if (
			// @ts-ignore
			txData?.error &&
			// @ts-ignore
			txData?.error?.message &&
			/No such mempool or blockchain transaction|Invalid tx hash/.test(
				// @ts-ignore
				txData?.error?.message
			)
		) {
			//Transaction was removed/bumped from the mempool or potentially reorg'd out.
			return false;
		}
		return true;
	}

	/**
	 * Returns the block hex of the provided block height.
	 * @param {number} [height]
	 * @param {TAvailableNetworks} [selectedNetwork]
	 * @returns {Promise<Result<string>>}
	 */
	public async getBlockHex({
		height = 0
	}: {
		height?: number;
	}): Promise<Result<string>> {
		const response: IGetHeaderResponse = await electrum.getHeader({
			height,
			network: this.electrumNetwork
		});
		if (response.error) {
			return err(response.data);
		}
		return ok(response.data);
	}

	/**
	 * Returns the block hash given a block hex.
	 * Leaving blockHex empty will return the last known block hash from storage.
	 * @param {string} [blockHex]
	 * @param {TAvailableNetworks} [selectedNetwork]
	 * @returns {string}
	 */
	public getBlockHashFromHex({ blockHex }: { blockHex?: string }): string {
		// If empty, return the last known block hex from storage.
		if (!blockHex) {
			const { hex } = this.getBlockHeader();
			blockHex = hex;
		}
		if (!blockHex) return '';
		const block = Block.fromHex(blockHex);
		const hash = block.getId();
		return hash;
	}

	/**
	 * Returns last known block height, and it's corresponding hex from local storage.
	 * @returns {IHeader}
	 */
	public getBlockHeader(): IHeader {
		return this.wallet.data.header;
	}

	/**
	 * Returns transactions associated with the provided transaction hashes.
	 * @param {ITxHash[]} txHashes
	 * @return {Promise<Result<IGetTransactionsFromInputs>>}
	 */
	async getTransactionsFromInputs({
		txHashes = []
	}: {
		txHashes: ITxHash[];
	}): Promise<Result<IGetTransactionsFromInputs>> {
		try {
			const data = {
				key: 'tx_hash',
				data: txHashes
			};
			const response = await electrum.getTransactions({
				txHashes: data,
				network: this.electrumNetwork
			});
			if (!response.error) {
				return ok(response);
			} else {
				return err(response);
			}
		} catch (e) {
			return err(e);
		}
	}

	/**
	 * Returns the merkle branch to a confirmed transaction given its hash and height.
	 * @param {string} tx_hash
	 * @param {number} height
	 * @returns {Promise<{ merkle: string[]; block_height: number; pos: number }>}
	 */
	async getTransactionMerkle({
		tx_hash,
		height
	}: {
		tx_hash: string;
		height: number;
	}): Promise<{
		merkle: string[];
		block_height: number;
		pos: number;
	}> {
		return await electrum.getTransactionMerkle({
			tx_hash,
			height,
			network: this.electrumNetwork
		});
	}

	/**
	 * Subscribes to the current networks headers.
	 * @return {Promise<Result<string>>}
	 */
	public async subscribeToHeader(): Promise<Result<IHeader>> {
		const subscribeResponse: ISubscribeToHeader =
			await electrum.subscribeHeader({
				network: this.electrumNetwork,
				onReceive: (data: INewBlock[]) => {
					const hex = data[0].hex;
					const hash = this.getBlockHashFromHex({ blockHex: hex });
					this._wallet.data.header = { ...data[0], hash };
					this._wallet.saveWalletData('header', this._wallet.data.header);
					this.onReceive?.(data);
					this.onMessage(onMessageKeys.newBlock, data[0]);
				}
			});
		if (subscribeResponse.error) {
			return err('Unable to subscribe to headers.');
		}
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore
		if (subscribeResponse?.data === 'Already Subscribed.') {
			return ok(this.getBlockHeader());
		}
		// Update local storage with current height and hex.
		const hex = subscribeResponse.data.hex;
		const hash = this.getBlockHashFromHex({ blockHex: hex });
		const header = { ...subscribeResponse.data, hash };
		this._wallet.data.header = header;
		return ok(header);
	}

	/**
	 * Subscribes to a number of address script hashes for receiving.
	 * @param {string[]} scriptHashes
	 * @param onReceive
	 * @return {Promise<Result<string>>}
	 */
	async subscribeToAddresses({
		scriptHashes = [],
		onReceive
	}: {
		scriptHashes?: string[];
		onReceive?: (data: TSubscribedReceive) => void;
	} = {}): Promise<Result<string>> {
		const currentWallet = this._wallet.data;
		const addressTypeKeys = objectKeys(addressTypes);
		// Gather the receiving address scripthash for each address type if no scripthashes were provided.
		if (!scriptHashes.length) {
			for (const addressType of addressTypeKeys) {
				const addresses = currentWallet.addresses[addressType];
				const addressCount = Object.keys(addresses).length;

				// Check if addresses of this type have been generated. If not, skip.
				if (addressCount > 0) {
					let addressIndex = currentWallet.addressIndex[addressType]?.index;
					addressIndex = addressIndex > 0 ? addressIndex : 0;

					// Only subscribe up to the gap limit.
					const addressesInRange = Object.values(addresses).filter(
						(address) => Math.abs(address.index - addressIndex) <= GAP_LIMIT
					);
					const addressesToSubscribe = addressesInRange.slice(-GAP_LIMIT);
					const addressScriptHashes = addressesToSubscribe.map(
						({ scriptHash }) => scriptHash
					);
					scriptHashes.push(...addressScriptHashes);
				}
			}
		}

		// Subscribe to all provided script hashes.
		const promises = scriptHashes.map(async (scriptHash) => {
			const response: ISubscribeToAddress = await electrum.subscribeAddress({
				scriptHash,
				network: this.electrumNetwork,
				onReceive: async (data: TSubscribedReceive): Promise<void> => {
					onReceive?.(data);
					this.onReceiveAddress(data);
					this._wallet.refreshWallet({});
				}
			});
			if (response.error) {
				throw Error('Unable to subscribe to receiving addresses.');
			}
		});

		try {
			await Promise.all(promises);
		} catch (e) {
			return err(e);
		}

		return ok('Successfully subscribed to addresses.');
	}

	private async onReceiveAddress(data): Promise<void> {
		if (!this._wallet?.onMessage) return;
		const receivedAt = data[0];
		const balance = await this._wallet.getScriptHashBalance(receivedAt);
		if (balance.isErr()) return;
		const address = this._wallet.getAddressFromScriptHash(receivedAt);
		if (!address) {
			console.log('Unable to run getAddressFromScriptHash');
			return;
		}
		const history = await this.getAddressHistory({
			scriptHashes: [address]
		});
		if (history.isErr()) {
			console.log(history.error.message);
			return;
		}
		if (!history.value.length) return;
		let message: TMessageKeys = onMessageKeys.transactionConfirmed;
		const lastTx = history.value[history.value.length - 1];
		const unconfirmedTransactions: string[] = Object.values(
			this._wallet.data.unconfirmedTransactions
		).map((tx) => tx.txid);
		if (!unconfirmedTransactions.includes(lastTx.tx_hash))
			message = onMessageKeys.transactionReceived;
		if (balance.value.unconfirmed <= 0) message = onMessageKeys.transactionSent;
		const txs: TTxResult[] = history.value.map((tx) => {
			return {
				tx_hash: tx.tx_hash,
				height: tx.height
			};
		});
		this._wallet.onMessage(message, {
			balance: balance.value,
			address: address,
			txs
		});
	}

	public async broadcastTransaction({
		rawTx,
		subscribeToOutputAddress = true
	}: {
		rawTx: string;
		subscribeToOutputAddress?: boolean;
	}): Promise<Result<string>> {
		/**
		 * Subscribe to the output address and refresh the wallet when the Electrum server detects it.
		 * This prevents updating the wallet prior to the Electrum server detecting the new tx in the mempool.
		 */
		if (subscribeToOutputAddress) {
			const transaction = this._wallet.transaction.data;
			for (const o of transaction.outputs) {
				const address = o?.address;
				if (address) {
					const scriptHash = getScriptHash({ address, network: this.network });
					if (scriptHash) {
						await this.subscribeToAddresses({
							scriptHashes: [scriptHash]
						});
					}
				}
			}
		}

		const broadcastResponse = await electrum.broadcastTransaction({
			rawTx,
			network: this.electrumNetwork
		});
		// TODO: This needs to be resolved in rn-electrum-client
		if (broadcastResponse.error || broadcastResponse.data.includes(' ')) {
			return err(broadcastResponse.data);
		}
		return ok(broadcastResponse.data);
	}

	/**
	 * Attempts to check the current Electrum connection.
	 * @private
	 * @returns {Promise<void>}
	 */
	private async checkConnection(): Promise<void> {
		try {
			const { error } = await electrum.pingServer();

			if (error) {
				console.log('Connection to Electrum Server lost, reconnecting...');
				const response = await this.connectToElectrum({});

				if (response.isErr()) {
					this.publishConnectionChange(false);
				}
			} else {
				this.publishConnectionChange(true);
			}
		} catch (e) {
			console.error(e);
			this.publishConnectionChange(false);
		}
	}

	private publishConnectionChange(isConnected: boolean): void {
		if (this.latestConnectionState === isConnected) {
			return;
		}

		if (!isConnected || this.latestConnectionState != null) {
			this.onMessage('onElectrumConnectionChange', isConnected);
		}
		this.connectedToElectrum = isConnected;
		this.latestConnectionState = isConnected;
	}

	public async disconnect(): Promise<void> {
		this.stopConnectionPolling();
		await electrum.stop();
	}

	public startConnectionPolling(): void {
		if (this.connectionPollingInterval) return;
		this.connectionPollingInterval = setInterval(
			(): Promise<void> => this.checkConnection(),
			POLLING_INTERVAL
		);
	}

	public stopConnectionPolling(): void {
		if (this.connectionPollingInterval) {
			clearInterval(this.connectionPollingInterval);
			this.connectionPollingInterval = null;
		}
	}
}
