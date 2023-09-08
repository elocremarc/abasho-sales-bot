import { postSweep, postTweet } from '../twitter-bot/twitter';
import { Penguin } from '../models/penguin';
import { request } from '../utilities/request';
import Web3 from 'web3';
import * as dotenv from 'dotenv';
import { getCoinGeckoId } from '../utilities/functions';
dotenv.config();

const ETHERSCAN_ABI_URL = process.env.ETHERSCAN_ENDPOINT || '';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '';
const OPENSEA_ADDRESS = process.env.OPENSEA_ADDRESS || '';
const SEAPORT_ADDRESS = process.env.SEAPORT_ADDRESS || '';
const LOOKS_RARE_ADDRESS = process.env.LOOKS_RARE_ADDRESS || '';
const BLUR_ADDRESS = process.env.BLUR_ADDRESS || '';
const BLUR_SWEEP_ADDRESS = process.env.BLUR_SWEEP_ADDRESS || '';
const BLUR_BLEND_ADDRESS = process.env.BLUR_BLEND_ADDRESS || '';
const X2Y2_ADDRESS = process.env.X2Y2_ADDRESS || '';
const UNISWAP_ADDRESS = process.env.UNISWAP_ADDRESS || '';
const WSS_PROVIDER = process.env.WSS_PROVIDER || '';
const PENGUIN_BASE_URL =
  'https://opensea.io/assets/ethereum/0xbd3531da5cf5857e7cfaa92426877b022e612cf8/';
const TRANSFER_EVENT_HASH =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const options = {
  // Enable auto reconnection
  reconnect: {
    auto: true,
    delay: 5000, // ms
    maxAttempts: 5,
    onTimeout: false,
  },
};
const web3 = new Web3(
  new Web3.providers.WebsocketProvider(WSS_PROVIDER, options)
);

let lastTx: string = '';

async function getContractAbi() {
  const abi = await request(
    `${ETHERSCAN_ABI_URL}${CONTRACT_ADDRESS}&apiKey=${ETHERSCAN_API_KEY}`
  );
  return JSON.parse(JSON.parse(abi).result);
}

async function getTokenInfo(address: string) {
  const tokenInfo = await request(
    `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=${address}&page=1&offset=1&apiKey=${ETHERSCAN_API_KEY}`
  );
  return JSON.parse(tokenInfo);
}

function tweetSale(
  event: any,
  price: string,
  tokenSymbol: string,
  usdValue: string
) {
  const url = `${PENGUIN_BASE_URL}${event.returnValues.tokenId}`;
  const penguin: Penguin = {
    id: event.returnValues.tokenId,
    price: {
      price: price,
      token: tokenSymbol,
      usdPrice: usdValue,
    },
    fromAddress: event.returnValues.from,
    toAddresss: event.returnValues.to,
    url: url,
  };
  postTweet(penguin).catch((error) => console.log(error));
}

async function getUsdValue(price: number, tokenSymbol: string) {
  const id = getCoinGeckoId(tokenSymbol);
  const usdValue = await request(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`
  );
  const usdJSON = JSON.parse(usdValue);
  const key = Object.keys(usdJSON)[0];
  const usdPrice = usdJSON[key].usd;
  return usdPrice * +price;
}

const getTxValue = (value: string) => {
  return +web3.utils.fromWei(value);
};

const getLogInfo = async (event: any, receipt: any) => {
  let tokenSymbol: string = '';
  let price: number = 0;

  for (let log of receipt.logs) {
    const to = web3.eth.abi
      .decodeParameter('address', log.topics[1])
      .toLowerCase();
    if (
      log.topics[0] === TRANSFER_EVENT_HASH &&
      to === event.returnValues.to.toLowerCase() &&
      log.data !== '0x'
    ) {
      const tokenInfo = await getTokenInfo(log.address);
      tokenSymbol = tokenInfo.result[0].tokenSymbol;
      price +=
        +web3.eth.abi.decodeParameter('uint256', log.data) /
        Math.pow(10, tokenInfo.result[0].tokenDecimal);
    }
  }

  return { tokenSymbol, price };
};

function getTokenCount(receipt: any): number {
  return receipt.logs.reduce((count: number, log: any) => {
    try {
      const from = web3.eth.abi
        .decodeParameter('address', log.topics[2])
        .toLowerCase();
      return log.topics[0] === TRANSFER_EVENT_HASH &&
        log.address === CONTRACT_ADDRESS &&
        from === receipt.from.toLowerCase() &&
        log.data === '0x'
        ? (count += 1)
        : count;
    } catch {
      return count;
    }
  }, 0);
}

export async function subscribeToSales() {
  const abi = await getContractAbi();
  const contract = new web3.eth.Contract(abi, CONTRACT_ADDRESS);
  contract.events
    .Transfer({})
    .on('connected', (subscriptionId: any) => {
      console.log('Subscribing to Pudgy Penguins contract');
    })
    .on('data', async (event: any) => {
      console.log('Transfer event');
      if (event.transactionHash != lastTx) {
        lastTx = event.transactionHash;
        const receipt = await web3.eth.getTransactionReceipt(
          event.transactionHash
        );
        const tokenCount = getTokenCount(receipt);
        web3.eth
          .getTransaction(event.transactionHash)
          .then(async (response) => {
            let tokenSymbol: string;
            let price: number;
            let txValue: number;
            let logInfo: any;
            if (
              response.to === OPENSEA_ADDRESS ||
              response.to === SEAPORT_ADDRESS ||
              response.to === LOOKS_RARE_ADDRESS ||
              response.to === BLUR_ADDRESS ||
              response.to === BLUR_BLEND_ADDRESS ||
              response.to === BLUR_SWEEP_ADDRESS ||
              response.to === X2Y2_ADDRESS ||
              response.to === UNISWAP_ADDRESS
            ) {
              tokenSymbol = 'ETH';
              txValue = getTxValue(response.value);
              logInfo = await getLogInfo(event, receipt);
              price = txValue + logInfo.price;
              const usdValue = await getUsdValue(
                price,
                logInfo.tokenSymbol || tokenSymbol
              );
              tokenCount > 1
                ? postSweep(
                    tokenCount,
                    price.toFixed(4),
                    `https://etherscan.io/tx/${event.transactionHash}`,
                    `$${usdValue.toFixed(2)}`
                  )
                : tweetSale(
                    event,
                    price.toFixed(4),
                    logInfo.tokenSymbol || tokenSymbol,
                    `$${usdValue.toFixed(2)}`
                  );
            } else {
              console.log('Non OpenSea or LooksRare Transfer');
            }
          });
      }
    })
    .on('changed', (event: any) => {
      // remove event from local database
      console.log('changed event');
    })
    .on('error', (error: any, receipt: any) => {
      // If the transaction was rejected by the network with a receipt, the second parameter will be the receipt.
      console.log('error');
      console.log(error);
    });
}
