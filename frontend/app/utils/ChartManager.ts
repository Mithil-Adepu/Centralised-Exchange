import {
  ColorType,
  createChart,
  CrosshairMode,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from "lightweight-charts";

const DEBUG = process.env.NODE_ENV !== "production";

function log(...args: unknown[]) {
  if (DEBUG) {
    console.log(...args);
  }
}

export class ChartManager {
  private candleSeries: ISeriesApi<"Candlestick">;

  private chart: IChartApi;

  constructor(
    ref: any,
    initialData: any[],
    layout: { background: string; color: string }
  ) {
    try {
      log('📊 Initializing chart with', initialData?.length || 0, 'candles');

      // Create chart with v4 API
      const chart = createChart(ref, {
        width: ref.clientWidth || ref.offsetWidth || 800,
        height: ref.clientHeight || ref.offsetHeight || 420,
        layout: {
          background: {
            type: ColorType.Solid,
            color: layout.background,
          },
          textColor: layout.color,
        },
        grid: {
          vertLines: {
            visible: false,
          },
          horzLines: {
            visible: false,
          },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
          borderColor: '#23242C',
        },
        timeScale: {
          borderColor: '#23242C',
          timeVisible: true,
          secondsVisible: false,
      },
    });

    this.chart = chart;

      // Add candlestick series with v4 API
      this.candleSeries = this.chart.addCandlestickSeries({
        upColor: '#00C087',
        downColor: '#EF454A',
        borderVisible: false,
        wickUpColor: '#00C087',
        wickDownColor: '#EF454A',
      });

      // Handle resize
      const resizeObserver = new ResizeObserver((entries) => {
        if (entries.length === 0 || entries[0]?.target !== ref) {
          return;
        }
        const newRect = entries[0]!.contentRect;
        this.chart.applyOptions({
          width: newRect.width,
          height: newRect.height,
        });
      });

      resizeObserver.observe(ref);

      // Set initial data with proper validation
      if (initialData && initialData.length > 0) {
        // Format and validate data
        const formattedData = initialData
          .map((data) => {
            // Handle timestamps properly
            let timestamp: number;
            
            if (data.timestamp instanceof Date) {
              timestamp = Math.floor(data.timestamp.getTime() / 1000);
            } else if (typeof data.timestamp === 'number') {
              // If timestamp is in milliseconds, convert to seconds
              timestamp = data.timestamp > 10000000000 
                ? Math.floor(data.timestamp / 1000) 
                : data.timestamp;
            } else {
              console.warn('⚠️ Invalid timestamp:', data.timestamp);
              return null;
            }

            // Validate timestamp is not NaN
            if (isNaN(timestamp) || timestamp <= 0) {
              console.warn('⚠️ Invalid timestamp value:', timestamp);
              return null;
            }

            return {
              time: timestamp as UTCTimestamp,
              open: parseFloat(data.open?.toString() || '0'),
              high: parseFloat(data.high?.toString() || '0'),
              low: parseFloat(data.low?.toString() || '0'),
              close: parseFloat(data.close?.toString() || '0'),
            };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null) // Remove nulls
          .filter((item) => {
            // Validate all price values
            return !isNaN(item.open) && !isNaN(item.high) && 
                   !isNaN(item.low) && !isNaN(item.close) &&
                   item.open > 0 && item.high > 0 && 
                   item.low > 0 && item.close > 0;
          })
          .sort((a, b) => a.time - b.time) // Sort ascending by time
          .filter((item, index, array) => {
            // Remove duplicate timestamps
            if (index === 0) return true;
            return item.time !== array[index - 1]!.time;
          });

        log('📊 Formatted', formattedData.length, 'valid candles');

        if (formattedData.length > 0) {
          // Final validation: ensure data is strictly ascending
          for (let i = 1; i < formattedData.length; i++) {
            if (formattedData[i]!.time <= formattedData[i - 1]!.time) {
              console.error('❌ Data not properly sorted at index', i);
              console.error('Previous:', formattedData[i - 1]);
              console.error('Current:', formattedData[i]);
              throw new Error('Chart data must be sorted in ascending order');
            }
          }

          this.candleSeries.setData(formattedData);

          log('✅ Chart initialized with', formattedData.length, 'candles');
        } else {
          console.warn('⚠️ No valid candle data to display');
        }
      }
    } catch (error) {
      console.error('❌ Error initializing chart:', error);
      throw error;
    }
  }

  public update(updatedPrice: any) {
    try {
      log('📊 Updating chart with:', updatedPrice);
      
      // Use the provided time or current time
      const updateTime = updatedPrice.time
        ? (updatedPrice.time > 1e12
            ? Math.floor(updatedPrice.time / 1000)
            : Math.floor(updatedPrice.time))
        : Math.floor(Date.now() / 1000);

      // Update the current candle with new price data
      this.candleSeries.update({
        time: updateTime as UTCTimestamp,
        close: parseFloat(updatedPrice.close),
        low: parseFloat(updatedPrice.low),
        high: parseFloat(updatedPrice.high),
        open: parseFloat(updatedPrice.open),
      });


      
      log('✅ Chart updated successfully');
    } catch (error) {
      console.error('❌ Error updating chart:', error);
    }
  }

  public destroy() {
    try {
      if (this.chart) {
    this.chart.remove();
      }
    } catch (error) {
      console.error('❌ Error destroying chart:', error);
    }
  }
}
