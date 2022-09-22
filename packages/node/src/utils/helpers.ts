import { ethers } from 'ethers';
import { DUMMY_ETH_ABI } from '../utils/dummy';

/**
 * It recieves a url which points to the ABI of a contract
 * it then fetches the ABI and returns it
 *
 * @param url  {string} the url of the ABI of the contract
 * @returns {Object} the json representation of the abi
 */
export const fetchABIJSONFromURL = (url: string) => {
	// TODO perform fetch operation to return an ABI
	return DUMMY_ETH_ABI;
};

/**
 * Get the default provider for teh passed in network
 *
 * @param networkChainId {string} the chain id of the network
 * @returns
 */
export const getDefaultProvider = (networkChainId: string) => {
	return new ethers.providers.InfuraProvider(
		+networkChainId,
		process.env.INFURA_API_KEY
	);
};
/**
 * Parse an event block into a suitable format
 * @param eventLog an event log instance from ethers
 * @returns
 */
export const parseBlockEvent = (eventLog: any) => {
	let { blockNumber, event, args } = eventLog;
	args = { ...args }; //convert the argument to an object
	// filter through the args to remove duplicates
	let parsedArgs = Object.create({});
	Object.keys(args).forEach((key) => {
		if (+key || +key === 0) return; //if the index is a number, it means it is a duplicate key we dont need
		parsedArgs[key] = args[key];
	});
	// filter through the args to remove duplicates
	return {
		parsedArgs,
		blockNumber,
		event,
	};
};
