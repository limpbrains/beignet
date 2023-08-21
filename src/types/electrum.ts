import {
	EAvailableNetworks,
	IAddress,
	IGetAddressBalanceRes,
	ITransaction,
	IUtxo
} from './wallet';

export type TElectrumNetworks = 'bitcoin' | 'bitcoinTestnet' | 'bitcoinRegtest';

export interface IConnectToElectrumRes {
	error: boolean;
}

export interface IElectrumGetAddressBalanceRes extends IGetAddressBalanceRes {
	error: boolean;
}

export type TServer = {
	host: string;
	ssl: number;
	tcp: number;
	protocol: EProtocol;
};
export type TProtocol = 'tcp' | 'ssl';
export enum EProtocol {
	tcp = 'tcp',
	ssl = 'ssl'
}

export interface IGetUtxosResponse {
	utxos: IUtxo[];
	balance: number;
}

export type TUnspentAddressScriptHashData = {
	[x: string]: IUtxo | IAddress;
};

export type TTxResult = {
	tx_hash: string;
	height: number;
};

export interface IGetAddressScriptHashesHistoryResponse {
	data: TTxResponse[];
	error: boolean;
	id: number;
	method: string;
	network: string;
}

export type TTxResponse = {
	data: IAddress;
	id: number;
	jsonrpc: string;
	param: string;
	result: TTxResult[];
};

export interface IGetAddressHistoryResponse extends TTxResult, IAddress {}

export interface IHeader {
	height: number;
	hash: string;
	hex: string;
}

export interface INewBlock {
	height: number;
	hex: string;
}

export interface IGetHeaderResponse {
	id: number;
	error: boolean;
	method: 'getHeader';
	data: string;
	network: EAvailableNetworks;
}

export interface IGetTransactionsFromInputs {
	error: boolean;
	id: number;
	method: string;
	network: string;
	data: ITransaction<{
		tx_hash: string;
		vout: number;
	}>[];
}

export interface ISubscribeToHeader {
	data: {
		height: number;
		hex: string;
	};
	error: boolean;
	id: string;
	method: string;
}

export interface ISubscribeToAddress {
	data: {
		id: number;
		jsonrpc: string;
		result: null;
	};
	error: boolean;
	id: number;
	method: string;
}

export type TSubscribedReceive = [string, string];

export interface IFormattedPeerData {
	ip?: string;
	host: string;
	version?: string;
	ssl: string | number;
	tcp: string | number;
}

export type ElectrumConnectionPubSub = {
	publish: (isConnected: boolean) => void;
	subscribe: (
		callback: (isConnected: boolean) => void
	) => ElectrumConnectionSubscription;
};

export type ElectrumConnectionSubscription = {
	remove(): void;
};