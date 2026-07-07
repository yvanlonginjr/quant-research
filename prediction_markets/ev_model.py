"""
Prediction Market Expected Value Framework
==========================================
Tools for evaluating prediction market contracts:
- Extract implied probability from market price
- Update probability using Bayes' theorem given analyst signal
- Calculate expected value and edge per contract
- Size positions using Kelly criterion
"""

def implied_probability(market_price, payout=100):
    """
    Extract the market-implied probability from a contract price.

    Args:
        market_price: current price of the contract
        payout: what the contract pays if event occurs (default $100)

    Returns:
        float: implied probability (0 to 1)

    Example:
        >>> implied_probability(40, 100)
        0.4  # market implies 40% chance of event
    """
    return market_price / payout


def bayesian_update(prior, signal_accuracy):
    """
    Update probability using Bayes' theorem after receiving a signal.

    Args:
        prior: prior probability of event occurring (0 to 1)
        signal_accuracy: probability that signal is correct (0 to 1)

    Returns:
        float: posterior probability after updating on signal

    Example:
        >>> bayesian_update(0.35, 0.70)
        0.558  # updated from 35% to ~55.8% after bullish signal
    """
    # P(Signal | Event) = signal_accuracy
    # P(Signal | No Event) = 1 - signal_accuracy
    p_signal_given_event = signal_accuracy
    p_signal_given_no_event = 1 - signal_accuracy

    # Total probability of signal: P(S) = P(S|E)*P(E) + P(S|~E)*P(~E)
    p_signal = p_signal_given_event * prior + p_signal_given_no_event * (1 - prior)

    # Bayes: P(E|S) = P(S|E) * P(E) / P(S)
    posterior = (p_signal_given_event * prior) / p_signal
    return round(posterior, 4)


def expected_value(true_prob, market_price, payout=100):
    """
    Calculate expected profit per contract given your true probability estimate.

    Args:
        true_prob: your estimated probability of event occurring
        market_price: what you pay per contract
        payout: contract payout if event occurs (default $100)

    Returns:
        float: expected profit per contract

    Example:
        >>> expected_value(0.55, 40, 100)
        15.0  # expect to profit $15 per contract
    """
    ev = true_prob * payout  # expected payout
    return round(ev - market_price, 4)  # subtract cost


def edge(true_prob, market_price, payout=100):
    """
    Calculate your edge vs the market as a percentage.
    Positive edge = you have an advantage, consider buying.
    Negative edge = market has an advantage, consider selling or passing.
    """
    market_implied = implied_probability(market_price, payout)
    return round(true_prob - market_implied, 4)


def kelly_fraction(true_prob, market_price, payout=100):
    """
    Kelly criterion: optimal fraction of bankroll to bet.

    Formula: f = (bp - q) / b
    Where:
        b = net odds (profit per unit risked)
        p = true probability of winning
        q = true probability of losing (1 - p)

    Returns:
        float: fraction of bankroll to allocate (0 to 1)
        Negative value means no bet (negative edge)
    """
    b = (payout - market_price) / market_price  # net odds
    p = true_prob
    q = 1 - p
    return round((b * p - q) / b, 4)


def position_summary(true_prob, market_price, n_contracts, payout=100, signal_accuracy=None):
    """
    Full position analysis for a prediction market contract.
    Prints a complete summary of edge, EV, and sizing.
    """
    if signal_accuracy:
        updated_prob = bayesian_update(true_prob, signal_accuracy)
        print(f"Prior probability:     {true_prob*100:.1f}%")
        print(f"After signal update:   {updated_prob*100:.1f}%")
        true_prob = updated_prob

    mkt_implied = implied_probability(market_price, payout)
    ev = expected_value(true_prob, market_price, payout)
    your_edge = edge(true_prob, market_price, payout)
    kelly = kelly_fraction(true_prob, market_price, payout)

    print(f"\n--- Position Summary ---")
    print(f"Market price:          ${market_price}")
    print(f"Market implied prob:   {mkt_implied*100:.1f}%")
    print(f"Your true prob:        {true_prob*100:.1f}%")
    print(f"Your edge:             {your_edge*100:.1f}%")
    print(f"EV per contract:       ${ev}")
    print(f"Kelly fraction:        {kelly*100:.1f}% of bankroll")
    print(f"Total EV ({n_contracts} contracts): ${round(ev * n_contracts, 2)}")
    print(f"Recommendation:        {'BUY' if your_edge > 0 else 'SELL' if your_edge < 0 else 'PASS'}")


if __name__ == "__main__":
    print("=== Prediction Market EV Analysis ===\n")
    position_summary(
        true_prob=0.55,
        market_price=40,
        n_contracts=50,
        payout=100,
        signal_accuracy=0.70
    )
