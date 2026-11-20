package com.benatif

/** USD per million tokens of the cloud model used as the "what you would have paid" reference. */
data class PriceReference(val model: String, val inputUsdPerMTok: Double, val outputUsdPerMTok: Double) {
    companion object {
        /** Same conservative default as sdk-core/src/cloud.ts, so savings are never overstated. */
        val DEFAULT = PriceReference(model = "claude-haiku-5-5", inputUsdPerMTok = 0.1, outputUsdPerMTok = 0.5)
    }
}

fun estimateSavingsUsd(tokensIn: Int, tokensOut: Int, ref: PriceReference = PriceReference.DEFAULT): Double =
    (tokensIn * ref.inputUsdPerMTok + tokensOut * ref.outputUsdPerMTok) / 1e6
