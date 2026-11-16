module Loyalty
  # The tier a yearly point total reaches, and the next one up.
  module Tier
    LEVELS = %w[
      bronze
      silver
      gold
    ].freeze

    def self.for(points)
      if points >= 5000
        "gold"
      elsif points >= 1000
        "silver"
      else
        "bronze"
      end
    end

    def self.next_level(tier)
      index = LEVELS.index(tier)
      raise ArgumentError, "unknown tier #{tier}" if index.nil?

      LEVELS[index + 1]
    end

    def self.summary(points)
      <<~TEXT
        #{points} points, tier #{self.for(points)}
        Gold starts at 5000 points.
      TEXT
    end
  end
end
