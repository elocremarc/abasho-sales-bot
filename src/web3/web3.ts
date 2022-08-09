import { postTweet } from "../twitter-bot/twitter";
import { Penguin } from "../models/penguin";
import { request } from "../utilities/request";
import Web3 from "web3";
import * as dotenv from "dotenv";
import { getCoinGeckoId } from "../utilities/functions";
dotenv.config();

const ETHERSCAN_ABI_URL = process.env.ETHERSCAN_ENDPOINT || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "";
const OPENSEA_ADDRESS = process.env.OPENSEA_ADDRESS || "";
const SEAPORT_ADDRESS = process.env.SEAPORT_ADDRESS || "";
const LOOKS_RARE_ADDRESS = process.env.LOOKS_RARE_ADDRESS || "";
const WSS_PROVIDER = process.env.WSS_PROVIDER || "";
const PENGUIN_BASE_URL =
  "https://opensea.io/assets/0xE9C79B33C3A06f5Ae7369599F5a1e2FF886e17F0/";
const TRANSFER_EVENT_HASH =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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

const _getNFTReceiver = (logs: any) => {
  for (let log of logs) {
    // ERC-20 Transfer returns the value in `data`, while ERC-721 has the same signature but returns empty data
    if (log.topics[0] === TRANSFER_EVENT_HASH && log.data === "0x") {
      // 2nd parameter of the `Transfer()` event contains the NFT receiver
      return web3.eth.abi.decodeParameter("address", log.topics[2]);
    }
  }
  return null;
};

function tweetSale(
  event: any,
  price: number,
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
  postTweet(penguin);
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

async function nonEthSale(event: any, receipt: any, nftReceiver: any) {
  let tokenSymbol: string = "";
  let price: number = 0;

  for (let log of receipt.logs) {
    const to = web3.eth.abi
      .decodeParameter("address", log.topics[1])
      .toLowerCase();
    if (
      log.topics[0] === TRANSFER_EVENT_HASH &&
      to === event.returnValues.to.toLowerCase() &&
      log.data !== "0x"
    ) {
      const tokenInfo = await getTokenInfo(log.address);
      tokenSymbol = tokenInfo.result[0].tokenSymbol;
      price +=
        +web3.eth.abi.decodeParameter("uint256", log.data) /
        Math.pow(10, tokenInfo.result[0].tokenDecimal);
    } else {
      console.log("Non sale transfer");
    }
  }

  const usdValue = await getUsdValue(price, tokenSymbol);
  tweetSale(event, price, tokenSymbol, `$${usdValue.toFixed(2)}`);
}

export async function subscribeToSales() {
  const abi = await getContractAbi();
  const contract = new web3.eth.Contract(abi, CONTRACT_ADDRESS);
  contract.events
    .Transfer({})
    .on("connected", (subscriptionId: any) => {
      console.log("Subscribing to Pudgy Penguins contract");
    })
    .on("data", async (event: any) => {
      console.log("Transfer event");
      const receipt = await web3.eth.getTransactionReceipt(
        event.transactionHash
      );
      const nftReceiver = _getNFTReceiver(receipt.logs);
      web3.eth.getTransaction(event.transactionHash).then(async (response) => {
        let tokenSymbol: string;
        let price: number;
        if (
          response.to === OPENSEA_ADDRESS ||
          response.to === SEAPORT_ADDRESS ||
          response.to === LOOKS_RARE_ADDRESS
        ) {
          if (+response.value != 0) {
            tokenSymbol = "ETH";
            price = +web3.utils.fromWei(response.value);
            const usdValue = await getUsdValue(price, tokenSymbol);
            tweetSale(event, price, tokenSymbol, `$${usdValue.toFixed(2)}`);
          } else {
            nonEthSale(event, receipt, nftReceiver);
          }
        } else {
          console.log("Non OpenSea or LooksRare Transfer");
        }
      });
    })
    .on("changed", (event: any) => {
      // remove event from local database
      console.log("changed event");
    })
    .on("error", (error: any, receipt: any) => {
      // If the transaction was rejected by the network with a receipt, the second parameter will be the receipt.
      console.log("error");
      console.log(error);
    });
}
