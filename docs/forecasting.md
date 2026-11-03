# How forecasts work

Before a campaign launches, the platform predicts its delivery and reach. The numbers update as you change the campaign form, and they're saved at launch so you can compare them with what really happens.

## The method

1. **Inventory.** Every ad request is counted by hour, genre, slot, country and device, whether or not an ad was served. The last 28 days give an average for each hour of the week.
2. **Available impressions.** The forecast walks through each hour of the flight, adding up matching requests inside the campaign's schedule.
3. **Competition.** Guaranteed campaigns already booked on overlapping inventory come off that total. Audience campaigns count only viewers who consented.
4. **Delivery.** Expected impressions are the smallest of what's available, the goal, what the budget buys, and any daily or frequency limit.
5. **Reach.** Each impression is assumed to land on a random viewer in the matching audience, which gives `reach = audience × (1 - e^(-impressions / audience))`.

The dashboard shows a range of ±15% and warns when inventory, budget or limits will fall short of the goal.

## Accuracy

`npm run forecast:check` hides the last 7 days of recorded inventory, forecasts them from the weeks before, and compares the two. It fails if any result is more than 15% out.

| Targeting | Forecast | Actual | Error |
|---|---|---|---|
| Everything | 12,616,272 | 13,235,413 | 4.7% |
| Germany | 4,414,295 | 4,631,270 | 4.7% |
| Sports | 2,868,720 | 3,363,425 | 14.7% |
| Connected TV | 6,307,986 | 6,619,064 | 4.7% |
| Pre-roll on mobile | 1,324,132 | 1,390,476 | 4.8% |
| Evenings, 18:00 to 22:59 | 6,622,581 | 7,181,073 | 7.8% |
| Weekends | 4,634,480 | 4,478,903 | 3.5% |
| Drama in France | 731,205 | 742,190 | 1.5% |

The average error is 5.8%. Sports is the hardest case, because big match nights can't be predicted from previous weeks. The seed starts from the current hour, so these figures move by a few tenths of a percent each time it runs.

## Limits of these results

- The history is generated demo data, not real viewers. It includes growth, day-to-day swings and unpredictable sports spikes, so the forecast has real uncertainty to deal with, but a real service would behave differently.
- The backtest uses one seeded history, so the numbers show how this method behaves rather than proving how it would perform everywhere.
- The backtest checks available impressions. It doesn't run a campaign through real days to compare final delivery.
- The reach formula hasn't been checked against real viewer behaviour. Real viewers watch unevenly, so actual reach would usually come in lower.
- Forecasts for auction campaigns assume they can use anything guaranteed campaigns haven't booked, regardless of rival bids. A bid under the auction floor is forecast at zero, with a warning.
