import { Next, ParsedVaaWithBytes } from "@wormhole-foundation/relayer-engine";
import { MyRelayerContext } from "./app";
import { calculateFee } from "@cosmjs/stargate";
import { fromUint8Array } from "js-base64";
import { getSeiSigningWasmClient } from "./sei";
import { CONFIG } from "./consts";
import { CHAIN_ID_SEI, TokenBridgePayload, parseTokenTransferPayload } from "@certusone/wormhole-sdk";

export class ApiController {
  preFilter(vaa: ParsedVaaWithBytes): boolean {
    const payload = parseTokenTransferPayload(vaa.payload);

    // 1. Make sure it's a token transfer payload3 VAA
    if (payload.payloadType !== TokenBridgePayload.TransferWithPayload) {
      return false;
    }

    // 2. Make sure it's going to Sei
    if (payload.toChain !== CHAIN_ID_SEI) {
      return false;
    }

    return true;
  }


  processFundsTransfer = async (ctx: MyRelayerContext, next: Next) => {
    await ctx.wallets.onSei(async (wallet, chainId) => {

      // get signed VAA bytes
      const signedVaa = ctx.vaaBytes;
      if (!signedVaa) {
        ctx.logger.error("received a vaa but no signed vaa bytes... skipping");
        await next();
        return;
      }

      // submit the VAA to the Sei token_translator contract
      const msg = {
        complete_transfer_and_convert: {
          vaa: fromUint8Array(signedVaa),
        },
      };
      const fee = calculateFee(1000000, "0.01usei");

      const signingClient = await getSeiSigningWasmClient(wallet.wallet);

      // safety isAlreadyRedeemed check will, in some cases, prevent us from submitting a duplicate message that
      // a different external relayer may have already submitting.
      const alreadyRedeemed = await signingClient.queryContractSmart(ctx.tokenBridge.addresses.sei, {
        is_vaa_redeemed: {
          vaa: fromUint8Array(ctx.vaaBytes),
        },
      });
      if (alreadyRedeemed.is_redeemed) {
        ctx.logger.info("VAA to Sei seen but already redeemed... skipping");
        await next();
        return;
      }

      const tx = await signingClient.execute(
        wallet.address,
        CONFIG.seiConfiguration.seiTranslator,
        msg,
        fee,
        "Wormhole - Complete Transfer"
      );

      ctx.logger.info(`Submitted complete transfer to Sei with hash ${tx.transactionHash}`);
    });

    // continue to next middleware
    await next();
  };
}
